import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { MAX_BULK_ITEMS, resolveItemEpochMs, NO_STORE_HEADERS } from '@/lib/bulk';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

/** Cadencia de persistencia en motor_telemetry (dashboard en vivo). La fidelidad 5 Hz vive en odrive_telemetry_bulk. */
const DASHBOARD_DOWNSAMPLE_MS = 1000;

export async function POST(req: NextRequest) {
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();
    const rawPayload = body?.payload;
    const { experiment_id } = body;

    if (!rawPayload || !Array.isArray(rawPayload)) {
      return NextResponse.json({ error: 'Payload must be an array' }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const payload = rawPayload.slice(0, MAX_BULK_ITEMS);

    // Borrador resoluble a partir del experimento activo cuando el firmware envía "backend_resolved".
    let resolvedExperimentId: string = experiment_id || 'idle';

    if (isSupabaseConfigured() && device) {
      let final_experiment_id = experiment_id;
      if (final_experiment_id === 'backend_resolved') {
          const { data: settingRow } = await supabaseAdmin
            .from('system_settings')
            .select('value')
            .eq('key', 'experiments_registry')
            .maybeSingle();

          if (settingRow && Array.isArray(settingRow.value)) {
            const activeExp = settingRow.value.find((e: any) => e.status === 'active');
            final_experiment_id = activeExp ? activeExp.id : 'idle';
          } else {
            final_experiment_id = 'idle';
          }
      }

      // 1. Insert into bulk archive table
      resolvedExperimentId = final_experiment_id || 'idle';
      const { error: bulkError } = await supabaseAdmin
        .from('odrive_telemetry_bulk')
        .insert({
          experiment_id: resolvedExperimentId,
          payload_json: payload,
          created_at: new Date().toISOString()
        });
        
      if (bulkError) {
        console.error('Error insertando bulk ODrive:', bulkError);
      }

      // 2. Map and bulk insert into motor_telemetry for real-time dashboard visualization.
      // V4/ADR-6: la fidelidad completa (5 Hz) queda en odrive_telemetry_bulk; el dashboard se
      // alimenta con una versión submuestreada a 1 Hz para no saturar la tabla.
      const rowsToInsert = payload
        .map((item: any) => {
          const is_on = Boolean(item.is_on ?? item.is_running);
          const speed_percent = Number(item.speed_percent ?? 0);
          const pwm_us = item.pwm_us !== undefined ? Number(item.pwm_us) : 1500;
          const voltage_v = item.voltage_v !== undefined ? Number(item.voltage_v) : null;
          const current_a = item.current_a !== undefined ? Number(item.current_a) : null;
          const power_w = item.power_w !== undefined
            ? Number(item.power_w)
            : (voltage_v && current_a ? Number((voltage_v * current_a).toFixed(2)) : null);
          const status_code = Number(item.status_code ?? 0);

          const epochMs = resolveItemEpochMs(item) ?? Date.now();
          const recordedAt = new Date(epochMs).toISOString();
          const actual_rpm = item.actual_rpm !== undefined ? Number(item.actual_rpm)
            : (item.rpm !== undefined ? Number(item.rpm) : null);
          const target_rpm = item.target_rpm !== undefined ? Number(item.target_rpm) : null;

          return {
            _epochMs: epochMs,
            device_id: device.id,
            recorded_at: recordedAt,
            is_on,
            speed_percent,
            rpm: actual_rpm,
            pwm_us,
            voltage_v,
            current_a,
            power_w,
            status_code
          };
        })
        .sort((a, b) => a._epochMs - b._epochMs)
        .filter((row, index, arr) => index === 0 || row._epochMs - arr[index - 1]._epochMs >= DASHBOARD_DOWNSAMPLE_MS)
        .map(({ _epochMs, ...rest }) => rest);

      if (rowsToInsert.length > 0) {
        const { error: insertError } = await supabaseAdmin
          .from('motor_telemetry')
          .insert(rowsToInsert);

        if (insertError) console.error('Error insertando en motor_telemetry:', insertError);
      }

      await supabaseAdmin.from('devices').update({
        status: 'online',
        last_seen_at: new Date().toISOString()
      }).eq('id', device.id);
    }

    return NextResponse.json({
      success: true,
      received: payload.length,
      experiment_id: resolvedExperimentId
    }, { headers: NO_STORE_HEADERS });
  } catch (error: any) {
    return NextResponse.json({ error: 'Payload error' }, { status: 400, headers: NO_STORE_HEADERS });
  }
}

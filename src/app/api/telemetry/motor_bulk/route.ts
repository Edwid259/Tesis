import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();
    const { experiment_id, payload } = body;
    
    if (!payload || !Array.isArray(payload)) {
       return NextResponse.json({ error: 'Payload must be an array' }, { status: 400 });
    }

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
      const { error: bulkError } = await supabaseAdmin
        .from('odrive_telemetry_bulk')
        .insert({
          experiment_id: final_experiment_id || 'idle',
          payload_json: payload,
          created_at: new Date().toISOString()
        });
        
      if (bulkError) {
        console.error('Error insertando bulk ODrive:', bulkError);
      }

      // 2. Map and bulk insert into motor_telemetry for real-time dashboard visualization
      const rowsToInsert = payload.map((item: any) => {
        const is_on = Boolean(item.is_on ?? item.is_running);
        const speed_percent = Number(item.speed_percent ?? 0);
        const pwm_us = item.pwm_us !== undefined ? Number(item.pwm_us) : 1500;
        const voltage_v = item.voltage_v !== undefined ? Number(item.voltage_v) : null;
        const current_a = item.current_a !== undefined ? Number(item.current_a) : null;
        const power_w = item.power_w !== undefined 
          ? Number(item.power_w) 
          : (voltage_v && current_a ? Number((voltage_v * current_a).toFixed(2)) : null);
        const status_code = Number(item.status_code ?? 0);
        
        let recordedAt = new Date().toISOString();
        if (item.datetime) {
           recordedAt = new Date(item.datetime).toISOString();
        } else if (item.rtc_timestamp_ms) {
           recordedAt = new Date(Number(item.rtc_timestamp_ms)).toISOString();
        }

        return {
          device_id: device.id,
          recorded_at: recordedAt,
          is_on,
          speed_percent,
          rpm: item.rpm !== undefined ? Number(item.rpm) : (item.actual_rpm !== undefined ? Number(item.actual_rpm) : null),
          pwm_us,
          voltage_v,
          current_a,
          power_w,
          status_code
        };
      });

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
      success: true
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'Payload error' }, { status: 400 });
  }
}

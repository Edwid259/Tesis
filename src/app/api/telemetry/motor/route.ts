import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Recibe telemetría desde el ESP32 del motor / aireador Thruster Blue Robotics T200
 * Formato esperado en JSON:
 * {
 *   "datetime": "2026-08-31T15:00:00Z",
 *   "is_on": true,
 *   "speed_percent": 65.0,
 *   "pwm_us": 1760,
 *   "voltage_v": 14.8,
 *   "current_a": 8.5,
 *   "power_w": 125.8,
 *   "status_code": 0
 * }
 */
export async function POST(req: NextRequest) {
  // 1. Autenticar dispositivo mediante X-Device-Key
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse || !device) return errorResponse ?? NextResponse.json({ error: 'Dispositivo no autorizado' }, { status: 401 });

  try {
    const body = await req.json();

    const rawList = Array.isArray(body.samples) && body.samples.length > 0 
      ? body.samples 
      : [body];

    const rowsToInsert = rawList.map((item: any) => {
      const is_on = Boolean(item.is_on);
      const speed_percent = Number(item.speed_percent ?? 0);
      const pwm_us = item.pwm_us !== undefined ? Number(item.pwm_us) : 1500;
      const voltage_v = item.voltage_v !== undefined ? Number(item.voltage_v) : null;
      const current_a = item.current_a !== undefined ? Number(item.current_a) : null;
      const power_w = item.power_w !== undefined 
        ? Number(item.power_w) 
        : (voltage_v && current_a ? Number((voltage_v * current_a).toFixed(2)) : null);
      const status_code = Number(item.status_code ?? 0);
      const recordedAt = item.datetime ? new Date(item.datetime).toISOString() : new Date().toISOString();

      return {
        device_id: device.id,
        recorded_at: recordedAt,
        is_on,
        speed_percent,
        pwm_us,
        voltage_v,
        current_a,
        power_w,
        status_code
      };
    });

    const latest = rowsToInsert[rowsToInsert.length - 1];

    // Si Supabase está configurado, guardar en PostgreSQL
    if (isSupabaseConfigured() && device) {
      const { error: insertError } = await supabaseAdmin
        .from('motor_telemetry')
        .insert(rowsToInsert);

      if (insertError) {
        console.error('Error guardando telemetría de motor:', insertError);
        return NextResponse.json({ error: 'Error al persistir telemetría de motor' }, { status: 500 });
      }

      await supabaseAdmin
        .from('devices')
        .update({
          status: 'online',
          last_seen_at: latest.recorded_at,
          updated_at: new Date().toISOString()
        })
        .eq('id', device.id);
    }

    return NextResponse.json({
      success: true,
      message: 'Telemetría de motor recibida correctamente',
      data: {
        recorded_at: latest.recorded_at,
        is_on: latest.is_on,
        speed_percent: latest.speed_percent,
        pwm_us: latest.pwm_us,
        samples_count: rowsToInsert.length
      }
    });

  } catch (error: any) {
    console.error('Error procesando telemetría de motor:', error);
    return NextResponse.json(
      { error: 'Formato de payload inválido', details: error.message },
      { status: 400 }
    );
  }
}

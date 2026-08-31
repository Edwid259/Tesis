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
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();

    const {
      datetime,
      is_on = false,
      speed_percent = 0,
      pwm_us = 1500,
      voltage_v,
      current_a,
      power_w,
      status_code = 0
    } = body;

    const recordedAt = datetime ? new Date(datetime).toISOString() : new Date().toISOString();

    // Si Supabase está configurado, guardar en PostgreSQL
    if (isSupabaseConfigured() && device) {
      const { error: insertError } = await supabaseAdmin
        .from('motor_telemetry')
        .insert({
          device_id: device.id,
          recorded_at: recordedAt,
          is_on: Boolean(is_on),
          speed_percent: Number(speed_percent),
          pwm_us: Number(pwm_us),
          voltage_v: voltage_v !== undefined ? Number(voltage_v) : null,
          current_a: current_a !== undefined ? Number(current_a) : null,
          power_w: power_w !== undefined ? Number(power_w) : (voltage_v && current_a ? Number((voltage_v * current_a).toFixed(2)) : null),
          status_code: Number(status_code)
        });

      if (insertError) {
        console.error('Error guardando telemetría de motor:', insertError);
        return NextResponse.json({ error: 'Error al persistir telemetría de motor' }, { status: 500 });
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Telemetría de motor recibida correctamente',
      data: {
        recorded_at: recordedAt,
        is_on,
        speed_percent,
        pwm_us
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

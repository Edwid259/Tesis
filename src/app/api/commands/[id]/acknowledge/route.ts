import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Permite que el ESP32 confirme la ejecución de una orden recibida
 * Parámetro dinámico: [id] (UUID del comando)
 * Payload opcional: { success: boolean, actual_speed_percent: number, error_message?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  // 1. Autenticar ESP32
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json().catch(() => ({}));
    const { success = true, actual_speed_percent, error_message } = body;

    if (!isSupabaseConfigured() || !device) {
      return NextResponse.json({
        success: true,
        message: 'Comando reconocido correctamente (Modo Local)'
      });
    }

    const { data: command, error } = await supabaseAdmin
      .from('control_commands')
      .update({
        status: success ? 'acknowledged' : 'failed',
        executed_at: new Date().toISOString(),
        error_message: error_message || null
      })
      .eq('id', id)
      .eq('device_id', device.id)
      .select()
      .single();

    if (error || !command) {
      return NextResponse.json({ error: 'Comando no encontrado o error en actualización' }, { status: 404 });
    }

    // Actualizar telemetría actual de motor si se recibió la velocidad confirmada
    if (actual_speed_percent !== undefined) {
      const speed = Number(actual_speed_percent);
      const pwm_us = Math.round(1500 + (speed / 100) * 400);
      await supabaseAdmin.from('motor_telemetry').insert({
        device_id: device.id,
        recorded_at: new Date().toISOString(),
        is_on: speed > 0,
        speed_percent: speed,
        pwm_us
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Confirmación de comando procesada exitosamente',
      command_id: id
    });

  } catch (error: any) {
    console.error('Error en /api/commands/[id]/acknowledge:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

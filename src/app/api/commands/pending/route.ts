import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Permite que el ESP32 del Thruster consulte comandos de control pendientes (polling HTTP/HTTPS)
 */
export async function GET(req: NextRequest) {
  // Autenticar que sea el ESP32 del motor
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse) return errorResponse;

  try {
    if (!isSupabaseConfigured() || !device) {
      return NextResponse.json({
        has_command: false,
        command: null
      });
    }

    // Buscar comando pendiente más antiguo
    const { data: commands, error } = await supabaseAdmin
      .from('control_commands')
      .select('*')
      .eq('device_id', device.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      console.error('Error buscando comandos pendientes:', error);
      return NextResponse.json({ error: 'Error al consultar órdenes' }, { status: 500 });
    }

    if (!commands || commands.length === 0) {
      return NextResponse.json({
        has_command: false,
        command: null
      });
    }

    const command = commands[0];

    // Marcar como 'sent' para evitar envíos duplicados
    await supabaseAdmin
      .from('control_commands')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString()
      })
      .eq('id', command.id);

    return NextResponse.json({
      has_command: true,
      command: {
        id: command.id,
        command_type: command.command_type,
        speed_percent: Number(command.speed_percent),
        pwm_us: command.pwm_us,
        payload: command.payload || {},
        created_at: command.created_at
      }
    });

  } catch (error: any) {
    console.error('Error en /api/commands/pending:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

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

    // 1. Buscar comando pendiente para este dispositivo especifico
    let { data: commands, error } = await supabaseAdmin
      .from('control_commands')
      .select('*')
      .eq('device_id', device.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    // 2. Si no encontro con device_id exacto, buscar cualquier comando pendiente global para motor
    if (!commands || commands.length === 0) {
      const fallbackQuery = await supabaseAdmin
        .from('control_commands')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (fallbackQuery.data && fallbackQuery.data.length > 0) {
        commands = fallbackQuery.data;
      }
    }

    if (error) {
      console.error('Error buscando comandos pendientes:', error);
      return NextResponse.json({ error: 'Error al consultar ordenes', details: error.message }, { status: 500 });
    }

    if (!commands || commands.length === 0) {
      // Diagnostico: adjuntar los ultimos comandos en la tabla
      const { data: recentCmds } = await supabaseAdmin
        .from('control_commands')
        .select('id, device_id, status, command_type, created_at')
        .order('created_at', { ascending: false })
        .limit(5);

      return NextResponse.json({
        has_command: false,
        command: null,
        debug: {
          authenticated_device_id: device.id,
          recent_commands: recentCmds || []
        }
      });
    }

    const command = commands[0];

    // Marcar como 'sent' para evitar envios duplicados
    const updateRes = await supabaseAdmin
      .from('control_commands')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString()
      })
      .eq('id', command.id);
    
    if (updateRes.error) {
      console.error('Error al actualizar status a sent:', updateRes.error);
    }

    return NextResponse.json({
      has_command: true,
      command: {
        id: command.id,
        device_id: command.device_id,
        status: command.status,
        command_type: command.command_type,
        speed_percent: Number(command.speed_percent),
        pwm_us: command.pwm_us,
        payload: command.payload || {},
        created_at: command.created_at
      },
      update_error: updateRes.error || null,
      update_count: updateRes.count || null
    });

  } catch (error: any) {
    console.error('Error en /api/commands/pending:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

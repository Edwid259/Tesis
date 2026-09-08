import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

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
      .order('created_at', { ascending: false })
      .limit(1);

    // 2. Si no encontro con device_id exacto, buscar cualquier comando pendiente global para motor
    if (!commands || commands.length === 0) {
      const fallbackQuery = await supabaseAdmin
        .from('control_commands')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
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
      return NextResponse.json({
        has_command: false,
        command: null
      });
    }

    const command = commands[0];

    // Marcar como 'sent' para evitar envios duplicados
    const updateRes = await supabaseAdmin
      .from('control_commands')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString()
      }, { count: 'exact' })
      .eq('id', command.id)
      .select();
    
    if (updateRes.error) {
      console.error('Error al actualizar status a sent:', updateRes.error);
    }

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

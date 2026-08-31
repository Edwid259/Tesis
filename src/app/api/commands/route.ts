import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Crea una nueva orden de control para el aireador desde la interfaz de usuario
 * Payload: { device_id, command_type: 'start'|'stop'|'set_speed'|'emergency_stop', speed_percent }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { device_id, command_type, speed_percent = 0, requested_by = 'Operador Web' } = body;

    if (!command_type) {
      return NextResponse.json({ error: 'command_type es requerido' }, { status: 400 });
    }

    // Calcular PWM estimado para Blue Robotics T200 (ESC Basic):
    // 0%  -> 1500 µs (Neutro / Detenido)
    // 100% -> 1900 µs (Máximo Avance)
    let speed = Math.max(0, Math.min(100, Number(speed_percent)));
    if (command_type === 'stop' || command_type === 'emergency_stop') {
      speed = 0;
    }

    const pwm_us = Math.round(1500 + (speed / 100) * 400);

    if (!isSupabaseConfigured()) {
      return NextResponse.json({
        success: true,
        message: 'Comando registrado con éxito (Modo Demo Local)',
        command: {
          id: 'demo-cmd-' + Date.now(),
          device_id: device_id || 'b0000000-0000-0000-0000-000000000002',
          command_type,
          speed_percent: speed,
          pwm_us,
          status: 'pending',
          created_at: new Date().toISOString()
        }
      });
    }

    // Resolver ID del dispositivo si no fue enviado
    let targetDeviceId = device_id;
    if (!targetDeviceId) {
      const { data: motorDev } = await supabaseAdmin
        .from('devices')
        .select('id')
        .eq('type', 'motor_thruster')
        .limit(1);
      
      if (motorDev && motorDev.length > 0) {
        targetDeviceId = motorDev[0].id;
      } else {
        return NextResponse.json({ error: 'No se encontró un dispositivo de motor registrado' }, { status: 404 });
      }
    }

    // Insertar comando en la cola
    const { data: cmd, error } = await supabaseAdmin
      .from('control_commands')
      .insert({
        device_id: targetDeviceId,
        command_type,
        speed_percent: speed,
        pwm_us,
        status: 'pending',
        requested_by
      })
      .select()
      .single();

    if (error) {
      console.error('Error creando comando de control:', error);
      return NextResponse.json({ error: 'Error al enviar orden al dispositivo' }, { status: 500 });
    }

    // Registrar evento de motor
    await supabaseAdmin.from('motor_events').insert({
      device_id: targetDeviceId,
      event_type: command_type === 'stop' ? 'stop' : (command_type === 'start' ? 'start' : 'speed_change'),
      speed_percent: speed,
      pwm_us,
      source: 'manual',
      notes: `Comando '${command_type}' enviado desde la dashboard web (${speed}% / ${pwm_us}µs)`
    });

    return NextResponse.json({
      success: true,
      message: 'Comando emitido exitosamente. En espera de confirmación por el ESP32.',
      command: cmd
    });

  } catch (error: any) {
    console.error('Error en POST /api/commands:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

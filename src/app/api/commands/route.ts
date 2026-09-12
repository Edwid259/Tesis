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
    const { device_id, command_type, speed_percent = 0, payload = {}, requested_by = 'Operador Web' } = body;

    if (!command_type) {
      return NextResponse.json({ error: 'command_type es requerido' }, { status: 400 });
    }

    const isSensorCommand = 
      device_id === 'a0000000-0000-0000-0000-000000000001' || 
      ['start_monitor', 'stop_monitor', 'set_sampling_rate', 'manual_sample', 'sleep', 'set_sleep_cycle'].includes(payload?.action);

    let speed = 0;
    let pwm_us = 1500;

    if (!isSensorCommand) {
      // Calcular PWM estimado para Blue Robotics T200 (ESC Basic):
      // 0%  -> 1500 us (Neutro / Detenido)
      // 100% -> 1900 us (Maximo Avance)
      speed = Math.max(0, Math.min(100, Number(speed_percent)));
      if (command_type === 'stop' || command_type === 'emergency_stop') {
        speed = 0;
      }
      pwm_us = Math.round(1500 + (speed / 100) * 400);
    }

    if (!isSupabaseConfigured()) {
      return NextResponse.json({
        success: true,
        message: isSensorCommand 
          ? `Comando para sensor registrado con éxito (${payload?.action || command_type}) [Modo Demo]`
          : 'Comando registrado con exito (Modo Demo Local)',
        command: {
          id: 'demo-cmd-' + Date.now(),
          device_id: device_id || (isSensorCommand ? 'a0000000-0000-0000-0000-000000000001' : 'b0000000-0000-0000-0000-000000000002'),
          command_type,
          speed_percent: speed,
          pwm_us,
          payload,
          status: 'pending',
          created_at: new Date().toISOString()
        }
      });
    }

    // Resolver ID del dispositivo si no fue enviado
    let targetDeviceId = device_id;
    if (!targetDeviceId) {
      const targetType = isSensorCommand ? 'sensor_do' : 'motor_thruster';
      const { data: foundDev } = await supabaseAdmin
        .from('devices')
        .select('id')
        .eq('type', targetType)
        .limit(1);
      
      if (foundDev && foundDev.length > 0) {
        targetDeviceId = foundDev[0].id;
      } else {
        return NextResponse.json({ error: `No se encontro un dispositivo de tipo ${targetType} registrado` }, { status: 404 });
      }
    }

    // Insertar comando en la cola de control_commands
    // Nota de robustez: Si la tabla en Supabase no tiene la columna 'payload', omitirla transparentemente
    const baseCommand = {
      device_id: targetDeviceId,
      command_type,
      speed_percent: speed,
      pwm_us,
      status: 'pending',
      requested_by
    };

    let cmd: any = null;
    let error: any = null;

    const resWithPayload = await supabaseAdmin
      .from('control_commands')
      .insert({ ...baseCommand, payload })
      .select()
      .single();

    if (resWithPayload.error && (resWithPayload.error.code === 'PGRST204' || resWithPayload.error.message?.includes('payload'))) {
      // Reintentar sin columna payload
      const resWithoutPayload = await supabaseAdmin
        .from('control_commands')
        .insert(baseCommand)
        .select()
        .single();
      cmd = resWithoutPayload.data;
      error = resWithoutPayload.error;
    } else {
      cmd = resWithPayload.data;
      error = resWithPayload.error;
    }

    if (error) {
      console.error('Error creando comando de control:', error);
      return NextResponse.json(
        {
          error: 'Error al enviar orden al dispositivo',
          details: error.message || error,
          code: error.code,
          hint: error.hint
        },
        { status: 500 }
      );
    }

    // Registrar evento de motor de forma no-bloqueante (solo para actuadores motor)
    if (!isSensorCommand) {
      try {
        await supabaseAdmin.from('motor_events').insert({
          device_id: targetDeviceId,
          event_type: command_type === 'stop' ? 'stop' : (command_type === 'start' ? 'start' : 'speed_change'),
          speed_percent: speed,
          pwm_us,
          source: 'manual',
          notes: `Comando '${command_type}' enviado desde la dashboard web (${speed}% / ${pwm_us}us)`
        });
      } catch (eventErr) {
        console.warn('Advertencia registrando evento de motor:', eventErr);
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Comando emitido exitosamente. En espera de confirmacion por el ESP32.',
      command: cmd
    });

  } catch (error: any) {
    console.error('Error en POST /api/commands:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

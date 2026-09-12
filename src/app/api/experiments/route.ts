import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { demoExperiments } from '@/lib/demoData';
import { Experiment } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

// En memoria para modo local/demo
let inMemoryExperiments: Experiment[] = [...demoExperiments as Experiment[]];

/**
 * GET: Obtener lista de experimentos registrados
 */
export async function GET(req: NextRequest) {
  try {
    if (!isSupabaseConfigured()) {
      return NextResponse.json({
        success: true,
        experiments: inMemoryExperiments
      });
    }

    // Intentar leer desde system_settings (clave: 'experiments_registry') o tabla dedicada
    const { data: settingRow } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', 'experiments_registry')
      .maybeSingle();

    let experiments: Experiment[] = [];
    if (settingRow && settingRow.value) {
      experiments = Array.isArray(settingRow.value) ? settingRow.value : [];
    } else {
      experiments = inMemoryExperiments;
    }

    return NextResponse.json({
      success: true,
      experiments
    });
  } catch (err: any) {
    console.error('Error obteniendo lista de experimentos:', err);
    return NextResponse.json(
      { error: 'Error al consultar experimentos', details: err.message },
      { status: 500 }
    );
  }
}

/**
 * POST: Iniciar un nuevo experimento
 * Body: { name, sampling_rate_sec, csv_filename, description }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      name,
      sampling_rate_sec = 5,
      csv_filename,
      description = ''
    } = body;

    if (!name || name.trim() === '') {
      return NextResponse.json({ error: 'El nombre del experimento es obligatorio' }, { status: 400 });
    }

    // Sanitizar nombre de archivo CSV para 8.3 FAT en firmware
    const cleanFilename = (csv_filename || `EXP_${Date.now().toString().slice(-4)}.CSV`)
      .toUpperCase()
      .replace(/[^A-Z0-9_.]/g, '')
      .slice(0, 12);
    const finalFilename = cleanFilename.endsWith('.CSV') ? cleanFilename : `${cleanFilename}.CSV`;

    const newExperiment: Experiment = {
      id: `exp_${Date.now()}`,
      name: name.trim(),
      description,
      sampling_rate_sec: Math.max(1, Math.min(60, Number(sampling_rate_sec))),
      csv_filename: finalFilename,
      status: 'active',
      started_at: new Date().toISOString(),
      ended_at: null,
      total_samples: 0
    };

    // 1. Despachar comando start_experiment al sensor mediante control_commands
    const targetDeviceId = 'a0000000-0000-0000-0000-000000000001';
    const commandPayload = {
      action: 'start_experiment',
      experiment_id: newExperiment.id,
      name: newExperiment.name,
      interval_sec: newExperiment.sampling_rate_sec,
      csv_filename: newExperiment.csv_filename
    };

    if (isSupabaseConfigured()) {
      // Guardar comando en cola
      await supabaseAdmin.from('control_commands').insert({
        device_id: targetDeviceId,
        command_type: 'start',
        speed_percent: 0,
        pwm_us: 1500,
        payload: commandPayload,
        status: 'pending',
        requested_by: `Experimento: ${newExperiment.name}`
      });

      // Actualizar metadatos de sensor para indicar experimento activo
      const { data: dev } = await supabaseAdmin
        .from('devices')
        .select('metadata')
        .eq('id', targetDeviceId)
        .single();

      const currentMeta = dev?.metadata || {};
      await supabaseAdmin
        .from('devices')
        .update({
          metadata: {
            ...currentMeta,
            monitor_active: true,
            active_experiment: newExperiment,
            monitor_interval_sec: newExperiment.sampling_rate_sec
          }
        })
        .eq('id', targetDeviceId);

      // Persistir lista de experimentos en system_settings
      const { data: settingRow } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'experiments_registry')
        .maybeSingle();

      let currentList: Experiment[] = settingRow?.value && Array.isArray(settingRow.value) ? settingRow.value : [];
      // Marcar previos como completados si quedaron colgados
      currentList = currentList.map(e => e.status === 'active' ? { ...e, status: 'completed', ended_at: new Date().toISOString() } : e);
      currentList.unshift(newExperiment);

      await supabaseAdmin
        .from('system_settings')
        .upsert({
          key: 'experiments_registry',
          value: currentList,
          description: 'Registro histórico de experimentos de oxigenación y muestreo'
        });
    } else {
      inMemoryExperiments = inMemoryExperiments.map(e => e.status === 'active' ? { ...e, status: 'completed', ended_at: new Date().toISOString() } : e);
      inMemoryExperiments.unshift(newExperiment);
    }

    return NextResponse.json({
      success: true,
      message: `Experimento '${newExperiment.name}' iniciado exitosamente`,
      experiment: newExperiment
    });

  } catch (err: any) {
    console.error('Error iniciando experimento:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * PATCH: Detener un experimento activo
 * Body: { experiment_id }
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { experiment_id } = body;

    const targetDeviceId = 'a0000000-0000-0000-0000-000000000001';
    const stopPayload = {
      action: 'stop_experiment',
      experiment_id
    };

    if (isSupabaseConfigured()) {
      // 1. Enviar orden stop al sensor
      await supabaseAdmin.from('control_commands').insert({
        device_id: targetDeviceId,
        command_type: 'stop',
        speed_percent: 0,
        pwm_us: 1500,
        payload: stopPayload,
        status: 'pending',
        requested_by: 'Detención de Experimento'
      });

      // 2. Actualizar metadatos de sensor
      const { data: dev } = await supabaseAdmin
        .from('devices')
        .select('metadata')
        .eq('id', targetDeviceId)
        .single();

      const currentMeta = dev?.metadata || {};
      await supabaseAdmin
        .from('devices')
        .update({
          metadata: {
            ...currentMeta,
            monitor_active: false,
            active_experiment: null
          }
        })
        .eq('id', targetDeviceId);

      // 3. Finalizar en lista de experimentos
      const { data: settingRow } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'experiments_registry')
        .maybeSingle();

      if (settingRow && Array.isArray(settingRow.value)) {
        const updated = settingRow.value.map((e: Experiment) => {
          if (!experiment_id || e.id === experiment_id || e.status === 'active') {
            return {
              ...e,
              status: 'completed',
              ended_at: new Date().toISOString()
            };
          }
          return e;
        });

        await supabaseAdmin
          .from('system_settings')
          .upsert({
            key: 'experiments_registry',
            value: updated
          });
      }
    } else {
      inMemoryExperiments = inMemoryExperiments.map(e => {
        if (!experiment_id || e.id === experiment_id || e.status === 'active') {
          return {
            ...e,
            status: 'completed',
            ended_at: new Date().toISOString()
          };
        }
        return e;
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Experimento finalizado correctamente'
    });

  } catch (err: any) {
    console.error('Error deteniendo experimento:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

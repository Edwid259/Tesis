import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export type ClearCategory = 'sensor_readings' | 'motor_telemetry' | 'experiments' | 'alerts_commands';
export type TimeScope = 'all' | 'older_than_1h' | 'older_than_24h' | 'older_than_today';

interface ClearRequestBody {
  categories: ClearCategory[];
  time_scope?: TimeScope;
}

/**
 * POST: Purgar datos de la base de datos de manera granular
 */
export async function POST(req: NextRequest) {
  try {
    const body: ClearRequestBody = await req.json();
    const { categories = [], time_scope = 'all' } = body;

    if (!Array.isArray(categories) || categories.length === 0) {
      return NextResponse.json(
        { error: 'Debe especificar al menos una categoría para limpiar.' },
        { status: 400 }
      );
    }

    // Calcular fecha límite de corte según time_scope
    let cutoffDate: Date;
    const now = new Date();

    switch (time_scope) {
      case 'older_than_1h':
        cutoffDate = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case 'older_than_24h':
        cutoffDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'older_than_today':
        cutoffDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        break;
      case 'all':
      default:
        cutoffDate = new Date('2099-12-31T23:59:59Z');
        break;
    }

    const cutoffIso = cutoffDate.toISOString();
    const results: Record<string, string> = {};

    if (isSupabaseConfigured()) {
      // 1. Lecturas del Sensor de Oxígeno Disuelto
      if (categories.includes('sensor_readings')) {
        const { error: srErr } = await supabaseAdmin
          .from('sensor_readings')
          .delete()
          .lte('recorded_at', cutoffIso);

        if (srErr) {
          console.error('Error eliminando sensor_readings:', srErr);
          results['sensor_readings'] = `Error: ${srErr.message}`;
        } else {
          results['sensor_readings'] = 'Eliminado exitosamente';
        }
      }

      // 2. Telemetría y Eventos de Motor (ODrive / ESC)
      if (categories.includes('motor_telemetry')) {
        const { error: mtErr } = await supabaseAdmin
          .from('motor_telemetry')
          .delete()
          .lte('recorded_at', cutoffIso);

        const { error: meErr } = await supabaseAdmin
          .from('motor_events')
          .delete()
          .lte('started_at', cutoffIso);

        if (mtErr || meErr) {
          results['motor_telemetry'] = `Error: ${mtErr?.message || meErr?.message}`;
        } else {
          results['motor_telemetry'] = 'Eliminado exitosamente';
        }
      }

      // 3. Alertas y Cola de Comandos
      if (categories.includes('alerts_commands')) {
        const { error: alErr } = await supabaseAdmin
          .from('alerts')
          .delete()
          .lte('created_at', cutoffIso);

        const { error: ccErr } = await supabaseAdmin
          .from('control_commands')
          .delete()
          .lte('created_at', cutoffIso);

        if (alErr || ccErr) {
          results['alerts_commands'] = `Error: ${alErr?.message || ccErr?.message}`;
        } else {
          results['alerts_commands'] = 'Eliminado exitosamente';
        }
      }

      // 4. Registro Histórico de Experimentos
      if (categories.includes('experiments')) {
        if (time_scope === 'all') {
          await supabaseAdmin
            .from('system_settings')
            .upsert({
              key: 'experiments_registry',
              value: [],
              description: 'Registro histórico de experimentos de oxigenación y muestreo'
            });

          // Resetear metadata en dispositivos
          await supabaseAdmin
            .from('devices')
            .update({
              metadata: { monitor_active: false, active_experiment: null }
            })
            .eq('id', 'a0000000-0000-0000-0000-000000000001');

          results['experiments'] = 'Registro de experimentos reseteado totalmente';
        } else {
          const { data: settingRow } = await supabaseAdmin
            .from('system_settings')
            .select('value')
            .eq('key', 'experiments_registry')
            .maybeSingle();

          if (settingRow && Array.isArray(settingRow.value)) {
            const cutoffMs = cutoffDate.getTime();
            const filtered = settingRow.value.filter((e: any) => {
              const startMs = new Date(e.started_at).getTime();
              return startMs > cutoffMs; // Conservar los posteriores al corte
            });

            await supabaseAdmin
              .from('system_settings')
              .upsert({
                key: 'experiments_registry',
                value: filtered,
                description: 'Registro histórico de experimentos de oxigenación y muestreo'
              });
          }
          results['experiments'] = 'Experimentos anteriores al corte eliminados';
        }
      }
    } else {
      results['modo_demo'] = 'Datos en memoria reiniciados (Modo Demo)';
    }

    return NextResponse.json({
      success: true,
      message: 'Operación de limpieza completada correctamente.',
      details: results,
      time_scope,
      cutoff: cutoffIso
    });

  } catch (err: any) {
    console.error('Error en endpoint de limpieza:', err);
    return NextResponse.json(
      { error: err.message || 'Error interno al limpiar base de datos' },
      { status: 500 }
    );
  }
}

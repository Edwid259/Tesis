import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { demoExperiments, generateDemoHistory } from '@/lib/demoData';
import { Experiment } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * GET: Descargar archivo CSV con las mediciones registradas durante el experimento
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  try {
    let experiment: Experiment | null = null;
    let readings: any[] = [];

    if (isSupabaseConfigured()) {
      // 1. Obtener experimento desde system_settings
      const { data: settingRow } = await supabaseAdmin
        .from('system_settings')
        .select('value')
        .eq('key', 'experiments_registry')
        .maybeSingle();

      if (settingRow && Array.isArray(settingRow.value)) {
        experiment = settingRow.value.find((e: Experiment) => e.id === id) || null;
      }

      if (experiment && experiment.started_at) {
        const query = supabaseAdmin
          .from('sensor_readings')
          .select('*')
          .gte('recorded_at', experiment.started_at);

        if (experiment.ended_at) {
          query.lte('recorded_at', experiment.ended_at);
        }

        const { data: rows } = await query.order('recorded_at', { ascending: true });
        readings = rows || [];
      }
    } else {
      // Modo Demo Local
      experiment = (demoExperiments as Experiment[]).find(e => e.id === id) || null;
      if (!experiment) {
        experiment = {
          id,
          name: `Experimento ${id}`,
          sampling_rate_sec: 5,
          csv_filename: `${id.slice(0, 8).toUpperCase()}.CSV`,
          status: 'completed',
          started_at: new Date(Date.now() - 3600000).toISOString(),
          ended_at: new Date().toISOString(),
          total_samples: 50
        };
      }
      // Generar datos sintéticos realistas para el CSV de descarga
      const demoPts = generateDemoHistory(2);
      readings = demoPts.map((pt, i) => ({
        recorded_at: pt.timestamp,
        seconds_since_2000: 841500000 + i * 5,
        dissolved_oxygen_mg_l: pt.dissolved_oxygen_mg_l || 7.5,
        oxygen_saturation_pct: pt.oxygen_saturation_pct || 98.0,
        water_temperature_c: pt.water_temperature_c || 24.2,
        battery_v: 4.20,
        status: 0
      }));
    }

    const filename = experiment?.csv_filename || `EXPERIMENTO_${id}.CSV`;

    // 2. Construir encabezados y contenido CSV
    const csvLines: string[] = [
      'Fecha_Hora_GMT, Segundos_2000, OD_mg_L, Saturacion_pct, Temp_Agua_C, Bateria_V, Status'
    ];

    readings.forEach((r) => {
      const dt = r.recorded_at ? new Date(r.recorded_at).toISOString() : '';
      const s2000 = r.seconds_since_2000 ?? '';
      const od = r.dissolved_oxygen_mg_l !== undefined ? Number(r.dissolved_oxygen_mg_l).toFixed(3) : '';
      const sat = r.oxygen_saturation_pct !== undefined ? Number(r.oxygen_saturation_pct).toFixed(2) : '';
      const temp = r.water_temperature_c !== undefined ? Number(r.water_temperature_c).toFixed(2) : '';
      const bat = r.battery_v !== undefined ? Number(r.battery_v).toFixed(2) : '';
      const status = r.status ?? 0;

      csvLines.push(`${dt}, ${s2000}, ${od}, ${sat}, ${temp}, ${bat}, ${status}`);
    });

    const csvContent = csvLines.join('\r\n');

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store'
      }
    });

  } catch (err: any) {
    console.error('Error generando descarga de CSV:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

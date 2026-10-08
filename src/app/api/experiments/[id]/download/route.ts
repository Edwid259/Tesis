import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { demoExperiments, generateDemoHistory } from '@/lib/demoData';
import { Experiment } from '@/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

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

      // Fallback: Si no está en la lista principal, revisar en metadata de devices (ej. si está activo)
      if (!experiment) {
        const { data: sensorDev } = await supabaseAdmin
          .from('devices')
          .select('metadata')
          .eq('id', 'a0000000-0000-0000-0000-000000000001')
          .maybeSingle();

        if (sensorDev?.metadata?.active_experiment?.id === id) {
          experiment = sensorDev.metadata.active_experiment;
        }
      }

      if (!experiment) {
        return NextResponse.json(
          { error: `Experimento '${id}' no encontrado en el registro.` },
          { status: 404 }
        );
      }

      if (experiment.started_at) {
        // Fetch bulk data
        const { data: sensorBulk } = await supabaseAdmin
          .from('sensor_telemetry_bulk')
          .select('payload_json')
          .eq('experiment_id', id);

        const { data: motorBulk } = await supabaseAdmin
          .from('odrive_telemetry_bulk')
          .select('payload_json')
          .eq('experiment_id', id);

        // Flatten payload_json arrays
        const flatSensor = (sensorBulk || []).flatMap((row: any) => row.payload_json || []);
        const flatMotor = (motorBulk || []).flatMap((row: any) => row.payload_json || []);

        // Align by time. If motor has exact ms, we can join. But sensor is at 0.2 Hz (every 5000ms), 
        // Motor is at 5 Hz (every 200ms).
        // Let's create an interpolated/aligned timeline based on rtc_timestamp_ms
        const timeMap = new Map<number, any>();

        // Insert motor data (higher frequency)
        for (const m of flatMotor) {
          const t = m.rtc_timestamp_ms;
          if (t && t > 0) {
            timeMap.set(t, { motor: m, sensor: null });
          }
        }

        // Insert sensor data
        for (const s of flatSensor) {
          // Sensor might not have exact rtc_timestamp_ms if not fully synced, 
          // or we can use seconds_since_2000
          // Let's assume sensor JSON has rtc_timestamp_ms or we fall back to seconds_since_2000 * 1000
          let t = s.rtc_timestamp_ms;
          if (!t) {
            if (s.seconds_since_2000) {
               // Approximate
               t = s.seconds_since_2000 * 1000;
            } else {
               t = new Date(s.datetime).getTime();
            }
          }
          
          if (!timeMap.has(t)) {
            timeMap.set(t, { motor: null, sensor: s });
          } else {
            const entry = timeMap.get(t);
            entry.sensor = s;
          }
        }

        // Sort by timestamp
        const sortedKeys = Array.from(timeMap.keys()).sort((a, b) => a - b);
        
        // Forward-fill sensor data (since it's lower frequency)
        let lastSensor: any = null;
        for (const k of sortedKeys) {
          const entry = timeMap.get(k);
          if (entry.sensor) {
            lastSensor = entry.sensor;
          } else {
            entry.sensor = lastSensor;
          }
          
          readings.push({
            rtc_timestamp_ms: k,
            ...entry.sensor,
            ...entry.motor
          });
        }
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
      'RTC_ms, OD_mg_L, Saturacion_pct, Temp_Agua_C, Motor_RPM, Motor_Target_RPM, Corriente_A, Voltaje_V'
    ];

    readings.forEach((r) => {
      const rtc = r.rtc_timestamp_ms || '';
      const od = r.do_milli_mg_l !== undefined ? Number(r.do_milli_mg_l / 1000.0).toFixed(3) : '';
      const sat = r.do_sat_deci_pct !== undefined ? Number(r.do_sat_deci_pct / 10.0).toFixed(2) : '';
      const temp = r.water_temp_centi !== undefined ? Number(r.water_temp_centi / 100.0).toFixed(2) : '';
      
      const motorAct = r.actual_rpm !== undefined ? Number(r.actual_rpm).toFixed(2) : '';
      const motorTgt = r.target_rpm !== undefined ? Number(r.target_rpm).toFixed(2) : '';
      const current = r.current_a !== undefined ? Number(r.current_a).toFixed(2) : '';
      const voltage = r.voltage_v !== undefined ? Number(r.voltage_v).toFixed(2) : '';

      csvLines.push(`${rtc}, ${od}, ${sat}, ${temp}, ${motorAct}, ${motorTgt}, ${current}, ${voltage}`);
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

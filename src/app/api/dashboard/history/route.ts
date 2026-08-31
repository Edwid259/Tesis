import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { generateDemoHistory } from '@/lib/demoData';
import { HistoryDataPoint } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * Obtiene series de tiempo para las gráficas según el rango: '1h', '24h', '7d', o fechas personalizadas
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') || '24h';
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');

  try {
    let hours = 24;
    if (range === '1h') hours = 1;
    else if (range === '24h') hours = 24;
    else if (range === '7d') hours = 24 * 7;

    if (!isSupabaseConfigured()) {
      const demoData = generateDemoHistory(hours);
      return NextResponse.json({
        success: true,
        range,
        data: demoData,
        isDemo: true
      });
    }

    // Calcular límites temporales
    let since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    let until = new Date().toISOString();

    if (startDateParam) {
      since = new Date(startDateParam).toISOString();
    }
    if (endDateParam) {
      until = new Date(endDateParam).toISOString();
    }

    // Consultar lecturas de sensor
    const { data: sensorData, error: sensorErr } = await supabaseAdmin
      .from('sensor_readings')
      .select('*')
      .gte('recorded_at', since)
      .lte('recorded_at', until)
      .order('recorded_at', { ascending: true })
      .limit(500);

    // Consultar telemetría de motor
    const { data: motorData, error: motorErr } = await supabaseAdmin
      .from('motor_telemetry')
      .select('*')
      .gte('recorded_at', since)
      .lte('recorded_at', until)
      .order('recorded_at', { ascending: true })
      .limit(500);

    if (sensorErr || motorErr) {
      console.error('Error consultando historial:', sensorErr || motorErr);
      // Fallback a demo si la consulta falla
      return NextResponse.json({
        success: true,
        range,
        data: generateDemoHistory(hours),
        isDemo: true
      });
    }

    // Si no hay datos en la BD todavía, retornar demo indicando estado
    if ((!sensorData || sensorData.length === 0) && (!motorData || motorData.length === 0)) {
      return NextResponse.json({
        success: true,
        range,
        data: generateDemoHistory(hours),
        isDemo: true,
        emptyDatabase: true
      });
    }

    // Fusionar y estructurar puntos temporales
    const historyPoints: HistoryDataPoint[] = [];

    // Mapear lecturas de sensor
    sensorData?.forEach(s => {
      const date = new Date(s.recorded_at);
      historyPoints.push({
        timestamp: s.recorded_at,
        timeLabel: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        dissolved_oxygen_mg_l: Number(s.dissolved_oxygen_mg_l),
        oxygen_saturation_pct: s.oxygen_saturation_pct ? Number(s.oxygen_saturation_pct) : undefined,
        water_temperature_c: Number(s.water_temperature_c),
        battery_v: s.battery_v ? Number(s.battery_v) : undefined
      });
    });

    // Añadir telemetría de motor al punto temporal más cercano o nuevo
    motorData?.forEach(m => {
      const date = new Date(m.recorded_at);
      const existing = historyPoints.find(p => Math.abs(new Date(p.timestamp).getTime() - date.getTime()) < 30000);
      if (existing) {
        existing.motor_speed_percent = Number(m.speed_percent);
        existing.motor_is_on = Boolean(m.is_on);
        existing.motor_power_w = m.power_w ? Number(m.power_w) : undefined;
      } else {
        historyPoints.push({
          timestamp: m.recorded_at,
          timeLabel: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          motor_speed_percent: Number(m.speed_percent),
          motor_is_on: Boolean(m.is_on),
          motor_power_w: m.power_w ? Number(m.power_w) : undefined
        });
      }
    });

    // Ordenar cronológicamente
    historyPoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return NextResponse.json({
      success: true,
      range,
      data: historyPoints,
      isDemo: false
    });

  } catch (error: any) {
    console.error('Error generando historial de dashboard:', error);
    return NextResponse.json(
      { error: 'Error al obtener historial', details: error.message },
      { status: 500 }
    );
  }
}

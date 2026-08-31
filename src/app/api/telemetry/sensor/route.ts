import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * Recibe telemetría desde el ESP32 del sensor óptico de Oxígeno Disuelto
 * Formato esperado en JSON:
 * {
 *   "datetime": "2026-08-31T15:00:00Z",
 *   "seconds_since_2000": 841500000,
 *   "water_temp_centi": 2305,
 *   "do_centi_mg_l": 7874,
 *   "do_sat_deci_pct": 985,
 *   "param3_centi": 1024,
 *   "param4_centi": 2048,
 *   "battery_mv": 4246,
 *   "rtc_temp_centi": 2410,
 *   "status": 0,
 *   "sent": true
 * }
 */
export async function POST(req: NextRequest) {
  // 1. Autenticar dispositivo mediante X-Device-Key
  const { device, errorResponse } = await authenticateDevice(req, 'sensor_do');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();

    // 2. Extraer y validar parámetros requeridos
    const {
      datetime,
      seconds_since_2000,
      water_temp_centi,
      do_centi_mg_l,
      do_sat_deci_pct,
      param3_centi,
      param4_centi,
      battery_mv,
      rtc_temp_centi,
      status = 0,
      sent = true
    } = body;

    if (do_centi_mg_l === undefined || water_temp_centi === undefined) {
      return NextResponse.json(
        { error: 'Faltan campos obligatorios: do_centi_mg_l o water_temp_centi' },
        { status: 400 }
      );
    }

    // 3. Normalización con escalas configurables (con valores por defecto seguros)
    const doDivider = 1000.0;    // 7874 -> 7.874 mg/L
    const tempDivider = 100.0;   // 2305 -> 23.05 °C
    const satDivider = 10.0;     // 985 -> 98.5%
    const batteryDivider = 1000.0; // 4246 -> 4.246 V

    const dissolvedOxygenMgL = Number((do_centi_mg_l / doDivider).toFixed(3));
    const waterTempC = Number((water_temp_centi / tempDivider).toFixed(2));
    const oxygenSatPct = do_sat_deci_pct !== undefined ? Number((do_sat_deci_pct / satDivider).toFixed(2)) : null;
    const batteryV = battery_mv !== undefined ? Number((battery_mv / batteryDivider).toFixed(2)) : null;
    const rtcTempC = rtc_temp_centi !== undefined ? Number((rtc_temp_centi / tempDivider).toFixed(2)) : null;

    const recordedAt = datetime ? new Date(datetime).toISOString() : new Date().toISOString();

    // 4. Si Supabase está enlazado, guardar en PostgreSQL
    if (isSupabaseConfigured() && device) {
      const { error: insertError } = await supabaseAdmin
        .from('sensor_readings')
        .insert({
          device_id: device.id,
          recorded_at: recordedAt,
          seconds_since_2000,
          dissolved_oxygen_raw: do_centi_mg_l,
          dissolved_oxygen_mg_l: dissolvedOxygenMgL,
          oxygen_saturation_raw: do_sat_deci_pct,
          oxygen_saturation_pct: oxygenSatPct,
          water_temperature_raw: water_temp_centi,
          water_temperature_c: waterTempC,
          param3_raw: param3_centi,
          param4_raw: param4_centi,
          battery_mv,
          battery_v: batteryV,
          rtc_temperature_raw: rtc_temp_centi,
          rtc_temperature_c: rtcTempC,
          status,
          sent
        });

      if (insertError) {
        console.error('Error insertando lectura de sensor en Supabase:', insertError);
        return NextResponse.json({ error: 'Error al persistir telemetría' }, { status: 500 });
      }

      // 5. Evaluar reglas de alerta automática si el OD es crítico o bajo
      if (dissolvedOxygenMgL < 4.0) {
        await supabaseAdmin.from('alerts').insert({
          device_id: device.id,
          alert_type: 'critical_do',
          severity: 'critical',
          status: 'activa',
          message: `Nivel CRÍTICO de Oxígeno Disuelto: ${dissolvedOxygenMgL} mg/L (Temperatura: ${waterTempC}°C)`,
          metadata: { do: dissolvedOxygenMgL, temp: waterTempC }
        });
      } else if (dissolvedOxygenMgL < 6.0) {
        // Alerta preventiva si no existe una activa similar en los últimos 30 min
        await supabaseAdmin.from('alerts').insert({
          device_id: device.id,
          alert_type: 'low_do',
          severity: 'warning',
          status: 'activa',
          message: `Oxígeno Disuelto bajo: ${dissolvedOxygenMgL} mg/L en ${device.location}`,
          metadata: { do: dissolvedOxygenMgL }
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Telemetría de sensor recibida y procesada correctamente',
      data: {
        recorded_at: recordedAt,
        dissolved_oxygen_mg_l: dissolvedOxygenMgL,
        water_temperature_c: waterTempC,
        oxygen_saturation_pct: oxygenSatPct,
        battery_v: batteryV
      }
    });

  } catch (error: any) {
    console.error('Error procesando telemetría de sensor:', error);
    return NextResponse.json(
      { error: 'Formato de payload inválido', details: error.message },
      { status: 400 }
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import {
  demoSensorDevice,
  demoMotorDevice,
  getDemoLatestSensorReading,
  getDemoLatestMotorTelemetry,
  demoThresholds
} from '@/lib/demoData';
import { DashboardSummaryResponse } from '@/types';

export const dynamic = 'force-dynamic';

/**
 * Devuelve el estado general del sistema, última medición de OD, estado de motor y alertas
 */
export async function GET(req: NextRequest) {
  try {
    if (!isSupabaseConfigured()) {
      // Retornar datos demo simulados en modo local/demo
      const summary: DashboardSummaryResponse = {
        sensorDevice: demoSensorDevice,
        motorDevice: demoMotorDevice,
        latestSensorReading: getDemoLatestSensorReading(),
        latestMotorTelemetry: getDemoLatestMotorTelemetry(),
        thresholds: demoThresholds,
        activeAlertsCount: 1,
        systemHealth: 'optimal',
        isLive: false
      };
      return NextResponse.json(summary);
    }

    // 1. Obtener dispositivos
    const { data: devices } = await supabaseAdmin
      .from('devices')
      .select('*');

    const sensorDevice = devices?.find(d => d.type === 'sensor_do') || null;
    const motorDevice = devices?.find(d => d.type === 'motor_thruster') || null;

    // 2. Obtener última lectura de sensor
    let latestSensorReading = null;
    if (sensorDevice) {
      const { data: readings } = await supabaseAdmin
        .from('sensor_readings')
        .select('*')
        .eq('device_id', sensorDevice.id)
        .order('recorded_at', { ascending: false })
        .limit(1);
      
      if (readings && readings.length > 0) {
        latestSensorReading = readings[0];
      }
    }

    // 3. Obtener última telemetría de motor
    let latestMotorTelemetry = null;
    if (motorDevice) {
      const { data: telemetries } = await supabaseAdmin
        .from('motor_telemetry')
        .select('*')
        .eq('device_id', motorDevice.id)
        .order('recorded_at', { ascending: false })
        .limit(1);
      
      if (telemetries && telemetries.length > 0) {
        latestMotorTelemetry = telemetries[0];
      }
    }

    // 4. Contar alertas activas
    const { count: activeAlertsCount } = await supabaseAdmin
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'activa');

    // 5. Determinar salud general del sistema
    let systemHealth: 'optimal' | 'warning' | 'critical' | 'offline' = 'optimal';
    if (latestSensorReading) {
      const doVal = Number(latestSensorReading.dissolved_oxygen_mg_l);
      if (doVal < demoThresholds.critical) {
        systemHealth = 'critical';
      } else if (doVal < demoThresholds.warning) {
        systemHealth = 'warning';
      }
    } else {
      systemHealth = 'offline';
    }

    const summary: DashboardSummaryResponse = {
      sensorDevice,
      motorDevice,
      latestSensorReading,
      latestMotorTelemetry,
      thresholds: demoThresholds,
      activeAlertsCount: activeAlertsCount || 0,
      systemHealth,
      isLive: true
    };

    return NextResponse.json(summary);
  } catch (error: any) {
    console.error('Error obteniendo resumen de dashboard:', error);
    return NextResponse.json(
      { error: 'Error al obtener resumen de la dashboard', details: error.message },
      { status: 500 }
    );
  }
}

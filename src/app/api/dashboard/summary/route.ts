import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import {
  demoSensorDevice,
  demoMotorDevice,
  demoEscDevice,
  getDemoLatestSensorReading,
  getDemoLatestMotorTelemetry,
  getDemoLatestEscTelemetry,
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
        escDevice: demoEscDevice,
        latestSensorReading: getDemoLatestSensorReading(),
        latestMotorTelemetry: getDemoLatestMotorTelemetry(),
        latestEscTelemetry: getDemoLatestEscTelemetry(),
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
    
    // Actuador Principal: ODrive S1 (M8325s)
    const motorDevice = devices?.find(d => 
      d.id === 'b0000000-0000-0000-0000-000000000002' || 
      (d.type === 'motor_thruster' && (d.metadata?.controller_model === 'ODrive S1' || d.name?.includes('ODrive')))
    ) || devices?.find(d => d.type === 'motor_thruster') || null;

    // Actuador Auxiliar: T-200 con ESC
    const escDevice = devices?.find(d => 
      d.id === 'c0000000-0000-0000-0000-000000000003' || 
      (d.type === 'motor_thruster' && d.id !== motorDevice?.id)
    ) || null;

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

    // 3. Obtener última telemetría de ODrive S1
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

    // 4. Obtener última telemetría de ESC Auxiliar (T-200)
    let latestEscTelemetry = null;
    if (escDevice) {
      const { data: escTelemetries } = await supabaseAdmin
        .from('motor_telemetry')
        .select('*')
        .eq('device_id', escDevice.id)
        .order('recorded_at', { ascending: false })
        .limit(1);
      
      if (escTelemetries && escTelemetries.length > 0) {
        latestEscTelemetry = escTelemetries[0];
      }
    }

    // 5. Contar alertas activas
    const { count: activeAlertsCount } = await supabaseAdmin
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'activa');

    // 6. Determinar salud general del sistema
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
      escDevice,
      latestSensorReading,
      latestMotorTelemetry,
      latestEscTelemetry,
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

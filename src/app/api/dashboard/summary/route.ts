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
import { DashboardSummaryResponse, Device } from '@/types';

export const dynamic = 'force-dynamic';

const HEARTBEAT_TIMEOUT_MS = 60 * 1000; // 60 segundos sin telemetría -> offline

function evaluateDeviceStatus(device: Device | null): Device | null {
  if (!device) return null;
  const isFresh = Boolean(
    device.last_seen_at &&
    (Date.now() - new Date(device.last_seen_at).getTime() < HEARTBEAT_TIMEOUT_MS)
  );

  return {
    ...device,
    status: isFresh ? 'online' : 'offline'
  };
}

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

    // 1. Obtener dispositivos desde Supabase
    const { data: rawDevices } = await supabaseAdmin
      .from('devices')
      .select('*');

    // Sensor de Oxígeno Disuelto
    const rawSensor = rawDevices?.find(d => d.type === 'sensor_do') || null;
    const sensorDevice = evaluateDeviceStatus(rawSensor);

    // Actuador Principal: ODrive S1 (M8325s)
    let rawMotor = rawDevices?.find(d => 
      d.id === 'b0000000-0000-0000-0000-000000000002' || 
      (d.type === 'motor_thruster' && (d.metadata?.controller_model === 'ODrive S1' || d.name?.includes('ODrive')))
    ) || rawDevices?.find(d => d.type === 'motor_thruster') || null;

    if (rawMotor) {
      // Normalizar nombre oficial de ODrive S1 si la BD aún tenía nombre legacy
      rawMotor = {
        ...rawMotor,
        name: 'Controlador ODrive S1 - Estanque 1',
        metadata: {
          ...rawMotor.metadata,
          controller_model: 'ODrive S1',
          motor: 'M8325s',
          interface: 'UART ASCII'
        }
      };
    }
    const motorDevice = evaluateDeviceStatus(rawMotor);

    // Actuador Auxiliar: Blue Robotics T-200 con ESC
    let rawEsc = rawDevices?.find(d => 
      d.id === 'c0000000-0000-0000-0000-000000000003' || 
      (d.type === 'motor_thruster' && d.id !== rawMotor?.id)
    ) || null;

    if (!rawEsc) {
      // Fallback predeterminado para el actuador auxiliar en caso de no haberse sincronizado aún
      rawEsc = {
        id: 'c0000000-0000-0000-0000-000000000003',
        name: 'Aireador Auxiliar ESC (Banco de Pruebas)',
        type: 'motor_thruster',
        location: 'Laboratorio / Banco de Pruebas',
        status: 'offline',
        last_seen_at: null,
        metadata: { controller_model: 'ESP32-S3 ESC PWM', motor: 'Blue Robotics T200' },
        created_at: new Date().toISOString()
      };
    }
    const escDevice = evaluateDeviceStatus(rawEsc);

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
        const telem = telemetries[0];
        // Si el motor está desconectado físicamente, la telemetría en tiempo real no puede estar encendida
        if (motorDevice.status === 'offline') {
          latestMotorTelemetry = {
            ...telem,
            is_on: false,
            speed_percent: 0,
            power_w: 0
          };
        } else {
          latestMotorTelemetry = telem;
        }
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
        const escTelem = escTelemetries[0];
        if (escDevice.status === 'offline') {
          latestEscTelemetry = {
            ...escTelem,
            is_on: false,
            speed_percent: 0,
            power_w: 0
          };
        } else {
          latestEscTelemetry = escTelem;
        }
      }
    }

    // 5. Contar alertas activas
    const { count: activeAlertsCount } = await supabaseAdmin
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'activa');

    // 6. Determinar salud general del sistema
    let systemHealth: 'optimal' | 'warning' | 'critical' | 'offline' = 'optimal';
    if (!sensorDevice || sensorDevice.status === 'offline') {
      systemHealth = 'warning'; // Sensor fuera de línea
    } else if (latestSensorReading) {
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


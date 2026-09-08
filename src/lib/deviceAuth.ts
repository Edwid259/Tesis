import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, hashApiKey, isSupabaseConfigured } from '@/lib/supabase';
import { Device, DeviceType } from '@/types';

interface KnownDeviceConfig {
  id: string;
  name: string;
  type: DeviceType;
  location: string;
  metadata: Record<string, any>;
  envVarKeys: string[];
  defaultTokens: string[];
}

const KNOWN_DEVICES: KnownDeviceConfig[] = [
  {
    id: 'a0000000-0000-0000-0000-000000000001',
    name: 'Sensor Óptico OD - Estanque 1',
    type: 'sensor_do',
    location: 'Estanque Principal (Zona Norte)',
    metadata: { sensor_model: 'Aqualabo DIGISENS', interface: 'Modbus RS485' },
    envVarKeys: ['ESP32_OD_SENSOR', 'ESP32_SENSOR_DEVICE_KEY'],
    defaultTokens: ['ESP32_OD_SENSOR', 'ESP32_SENSOR_KEY_2026']
  },
  {
    id: 'b0000000-0000-0000-0000-000000000002',
    name: 'Controlador ODrive S1 - Estanque 1',
    type: 'motor_thruster',
    location: 'Estanque Principal (Zona Central)',
    metadata: { controller_model: 'ODrive S1', interface: 'UART ASCII', control_mode: 'pid' },
    envVarKeys: ['ESP32_ODRIVE', 'ESP32_MOTOR_DEVICE_KEY'],
    defaultTokens: ['ESP32_ODRIVE', 'ESP32_MOTOR_KEY_2026']
  },
  {
    id: 'c0000000-0000-0000-0000-000000000003',
    name: 'Aireador Auxiliar ESC (Banco de Pruebas)',
    type: 'motor_thruster',
    location: 'Laboratorio / Banco de Pruebas',
    metadata: { controller_model: 'ESP32-S3 ESC PWM', status: 'auxiliary_backup' },
    envVarKeys: ['ESP32_T_200', 'ESP32_ESC_DEVICE_KEY'],
    defaultTokens: ['ESP32_T_200', 'ESP32_ESC_KEY_2026']
  }
];

function resolveKnownDevice(deviceKey: string): Device | null {
  for (const cfg of KNOWN_DEVICES) {
    // 1. Coincidencia directa con tokens por defecto o alias conocidos
    if (cfg.defaultTokens.includes(deviceKey)) {
      return {
        id: cfg.id,
        name: cfg.name,
        type: cfg.type,
        location: cfg.location,
        status: 'online',
        last_seen_at: new Date().toISOString(),
        metadata: cfg.metadata,
        created_at: new Date().toISOString()
      };
    }

    // 2. Coincidencia con variables de entorno (e.g. configuradas en Vercel)
    for (const envKey of cfg.envVarKeys) {
      const envVal = process.env[envKey];
      if (envVal && (envVal === deviceKey || envKey === deviceKey)) {
        return {
          id: cfg.id,
          name: cfg.name,
          type: cfg.type,
          location: cfg.location,
          status: 'online',
          last_seen_at: new Date().toISOString(),
          metadata: cfg.metadata,
          created_at: new Date().toISOString()
        };
      }
    }
  }
  return null;
}

/**
 * Autentica una petición de un dispositivo IoT (ESP32) mediante la cabecera X-Device-Key
 */
export async function authenticateDevice(req: NextRequest, expectedType?: string): Promise<{ device: Device | null; errorResponse: NextResponse | null }> {
  const deviceKey = req.headers.get('x-device-key') || req.headers.get('X-Device-Key') || req.nextUrl?.searchParams?.get('device_key') || null;

  if (!deviceKey) {
    return {
      device: null,
      errorResponse: NextResponse.json(
        { error: 'Encabezado X-Device-Key faltante' },
        { status: 401 }
      )
    };
  }

  // Nivel 1: Verificar contra dispositivos conocidos y variables de entorno de Vercel
  const knownDevice = resolveKnownDevice(deviceKey);
  if (knownDevice) {
    // Validar tipo esperado si fue especificado por la ruta
    if (expectedType && knownDevice.type !== expectedType) {
      return {
        device: null,
        errorResponse: NextResponse.json(
          { error: `Dispositivo '${knownDevice.name}' no autorizado para endpoints de tipo '${expectedType}'` },
          { status: 403 }
        )
      };
    }

    // Si Supabase está enlazado en producción, sincronizar dispositivo (upsert transparente)
    // Esto garantiza que el device_id exista para claves foráneas sin requerir SQL manual
    if (isSupabaseConfigured()) {
      try {
        await supabaseAdmin.from('devices').upsert({
          id: knownDevice.id,
          name: knownDevice.name,
          type: knownDevice.type,
          api_key_hash: hashApiKey(deviceKey),
          location: knownDevice.location,
          status: 'online',
          last_seen_at: new Date().toISOString(),
          metadata: knownDevice.metadata
        }, { onConflict: 'id' });
      } catch (upsertErr) {
        console.warn('Advertencia al sincronizar dispositivo en Supabase:', upsertErr);
      }
    }

    return { device: knownDevice, errorResponse: null };
  }

  // Si Supabase no está configurado y no coincidió con ninguna clave conocida
  if (!isSupabaseConfigured()) {
    return {
      device: null,
      errorResponse: NextResponse.json(
        { error: 'Clave de dispositivo no reconocida en modo local' },
        { status: 403 }
      )
    };
  }

  // Nivel 2: Búsqueda dinámica en Supabase mediante hash SHA-256
  const keyHash = hashApiKey(deviceKey);

  try {
    let query = supabaseAdmin
      .from('devices')
      .select('*')
      .eq('api_key_hash', keyHash);

    if (expectedType) {
      query = query.eq('type', expectedType);
    }

    const { data: devices, error } = await query.limit(1);

    if (error || !devices || devices.length === 0) {
      return {
        device: null,
        errorResponse: NextResponse.json(
          { error: 'Clave de dispositivo inválida o no autorizada' },
          { status: 403 }
        )
      };
    }

    const device = devices[0] as Device;

    // Actualizar último contacto y estado del dispositivo
    await supabaseAdmin
      .from('devices')
      .update({
        last_seen_at: new Date().toISOString(),
        status: 'online',
        updated_at: new Date().toISOString()
      })
      .eq('id', device.id);

    return { device, errorResponse: null };
  } catch (err: any) {
    console.error('Error en autenticación de dispositivo:', err);
    return {
      device: null,
      errorResponse: NextResponse.json(
        { error: 'Error interno en verificación de seguridad' },
        { status: 500 }
      )
    };
  }
}


import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, hashApiKey, isSupabaseConfigured } from '@/lib/supabase';
import { Device } from '@/types';

/**
 * Autentica una petición de un dispositivo IoT (ESP32) mediante la cabecera X-Device-Key
 */
export async function authenticateDevice(req: NextRequest, expectedType?: string): Promise<{ device: Device | null; errorResponse: NextResponse | null }> {
  const deviceKey = req.headers.get('x-device-key') || req.headers.get('X-Device-Key');

  if (!deviceKey) {
    return {
      device: null,
      errorResponse: NextResponse.json(
        { error: 'Encabezado X-Device-Key faltante' },
        { status: 401 }
      )
    };
  }

  // Si Supabase no está configurado en producción todavía, permitir llaves demo conocidas
  if (!isSupabaseConfigured()) {
    if (deviceKey === 'ESP32_SENSOR_KEY_2026' || deviceKey === 'ESP32_MOTOR_KEY_2026') {
      const isSensor = deviceKey === 'ESP32_SENSOR_KEY_2026';
      return {
        device: {
          id: isSensor ? 'a0000000-0000-0000-0000-000000000001' : 'b0000000-0000-0000-0000-000000000002',
          name: isSensor ? 'Sensor Óptico OD (Modo Local)' : 'Aireador Thruster T200 (Modo Local)',
          type: isSensor ? 'sensor_do' : 'motor_thruster',
          location: 'Estanque Principal',
          status: 'online',
          last_seen_at: new Date().toISOString(),
          created_at: new Date().toISOString()
        },
        errorResponse: null
      };
    }
  }

  // Hashear la clave recibida
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

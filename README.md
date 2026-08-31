# AquaControl - Dashboard Web de Acuicultura & Telemetría IoT

AquaControl es una plataforma web profesional para la monitorización en tiempo real y control remoto de sistemas de aireación en acuicultura de alta precisión. Conecta microcontroladores **ESP32** (medición de Oxígeno Disuelto y propulsión mediante Thruster **Blue Robotics T200**) con **Supabase PostgreSQL** y se despliega de forma serverless en **Vercel**.

---

## 1. Justificación de la Arquitectura

Para este sistema se seleccionó una arquitectura basada en **Next.js 14 (App Router) + TypeScript + Tailwind CSS + Supabase PostgreSQL + Vercel**:

1. **Next.js 14 Full-Stack Serverless en Vercel:**
   - **Frontend & Backend unificados:** Permite alojar tanto la interfaz gráfica reactiva como los endpoints REST seguros (`/api/telemetry/*`, `/api/commands/*`) en un único repositorio sin gestionar servidores Linux dedicados.
   - **Compatibilidad nativa con Vercel:** Tiempos de arranque en frío cercanos a cero, escalabilidad instantánea y latencia mínima global gracias a Vercel Edge Network.
2. **Supabase PostgreSQL & Row Level Security (RLS):**
   - Base de datos relacional robusta con soporte para tipos numéricos de alta precisión (`NUMERIC(6,3)`), índices B-Tree de alta velocidad sobre series temporales y seguridad por políticas RLS.
   - Autenticación administrativa de endpoints mediante *Service Role* y hashing SHA-256 de claves de dispositivo.
3. **Escalabilidad Futura (Render / Workers dedicados):**
   - La arquitectura actual opera 100% serverless en Vercel y Supabase, eliminando costos y complejidad de servidores en la fase inicial.
   - **Fase Futura en Render:** Cuando se requiera procesamiento de series de tiempo de alto volumen, reportes PDF/Excel periódicos en background, procesamiento por lotes con Python/Pandas o alertas vía SMS/WhatsApp mediante websockets persistentes, se puede desplegar un worker ligero en Render conectado a la misma base de datos de Supabase.

---

## 2. Configuración de Base de Datos en Supabase

1. Crea un proyecto en [Supabase](https://supabase.com/).
2. Ve al **SQL Editor** en el panel lateral de Supabase.
3. Abre el archivo [`supabase/schema.sql`](file:///supabase/schema.sql) de este repositorio, copia todo su contenido y ejecútalo en el editor SQL.
4. Esto creará:
   - Tablas: `devices`, `sensor_readings`, `motor_telemetry`, `motor_events`, `alerts`, `control_commands`, `system_settings`.
   - Índices para consultas instantáneas en series de tiempo.
   - Dispositivos iniciales de prueba y configuraciones de calibración.

---

## 3. Configuración de Variables de Entorno

Copia el archivo `.env.example` como `.env.local`:

```bash
cp .env.example .env.local
```

Configura los valores con los datos de tu proyecto de Supabase (**Settings -> API**):

```env
NEXT_PUBLIC_SUPABASE_URL=https://tu-proyecto.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# Tokens secretos de los ESP32 (Se valida contra SHA-256 en la base de datos)
ESP32_SENSOR_DEVICE_KEY=ESP32_SENSOR_KEY_2026
ESP32_MOTOR_DEVICE_KEY=ESP32_MOTOR_KEY_2026
```

---

## 4. Despliegue en Vercel

1. Sube este repositorio a tu cuenta de **GitHub**.
2. Ingresa a [Vercel](https://vercel.com/) y selecciona **Add New Project**.
3. Importa el repositorio de GitHub.
4. En la sección **Environment Variables**, añade las mismas variables de tu `.env.local`.
5. Haz clic en **Deploy**. ¡Tu dashboard quedará pública bajo HTTPS en segundos!

---

## 5. Guía de Conexión para los Microcontroladores ESP32

Ambos ESP32 deben enviar peticiones HTTPS seguras incluyendo la cabecera `X-Device-Key`.

### A. ESP32 del Sensor Óptico de Oxígeno Disuelto

**Endpoint:** `POST https://tu-dominio.vercel.app/api/telemetry/sensor`  
**Header:** `X-Device-Key: ESP32_SENSOR_KEY_2026`  
**Ejemplo de Payload JSON enviado por el ESP32:**

```json
{
  "datetime": "2026-08-31T15:00:00Z",
  "seconds_since_2000": 841500000,
  "water_temp_centi": 2305,
  "do_centi_mg_l": 7874,
  "do_sat_deci_pct": 985,
  "param3_centi": 1024,
  "param4_centi": 2048,
  "battery_mv": 4246,
  "rtc_temp_centi": 2410,
  "status": 0,
  "sent": true
}
```

*Nota sobre escalas:*
- `do_centi_mg_l = 7874` se almacena en bruto y se normaliza automáticamente a `7.874 mg/L`.
- `water_temp_centi = 2305` se almacena en bruto y se normaliza a `23.05 °C`.
- `battery_mv = 4246` se normaliza a `4.25 V`.

---

### B. ESP32 del Aireador (Thruster Blue Robotics T200)

**1. Envío de Telemetría:**  
**Endpoint:** `POST https://tu-dominio.vercel.app/api/telemetry/motor`  
**Header:** `X-Device-Key: ESP32_MOTOR_KEY_2026`  
**Payload JSON:**

```json
{
  "datetime": "2026-08-31T15:00:00Z",
  "is_on": true,
  "speed_percent": 65.0,
  "pwm_us": 1760,
  "voltage_v": 14.8,
  "current_a": 8.5,
  "power_w": 125.8,
  "status_code": 0
}
```

**2. Consulta de Comandos Pendientes (Polling cada 3-5 segundos):**  
**Endpoint:** `GET https://tu-dominio.vercel.app/api/commands/pending`  
**Header:** `X-Device-Key: ESP32_MOTOR_KEY_2026`  

**Respuesta recibida por el ESP32:**
```json
{
  "has_command": true,
  "command": {
    "id": "e4f801bc-...",
    "command_type": "set_speed",
    "speed_percent": 75,
    "pwm_us": 1800
  }
}
```

**3. Confirmación de Ejecución de la Orden:**  
**Endpoint:** `POST https://tu-dominio.vercel.app/api/commands/{id}/acknowledge`  
**Header:** `X-Device-Key: ESP32_MOTOR_KEY_2026`  
**Payload:**
```json
{
  "success": true,
  "actual_speed_percent": 75
}
```

---

## 6. Pruebas Locales y Simulación

Para probar la plataforma en tu equipo sin hardware físico:

1. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   ```
2. Abre en tu navegador: [http://localhost:3000](http://localhost:3000).
3. En otra terminal, ejecuta el simulador de ambos ESP32:
   ```bash
   node scripts/simulate-esp32.js
   ```
4. Podrás ver en tiempo real cómo las tarjetas, gráficas y estados se actualizan automáticamente y cómo responde el simulador al enviar órdenes desde la web.

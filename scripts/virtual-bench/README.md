# Banco de pruebas virtual (gemelo digital de los 4 nodos)

Simula la flota completa del banco contra la API web real, **sin hardware**: el OD-Logger, el
controlador ODrive, el mixer T-200 y la bomba dosificadora. Sirve para validar la orquestación
mientras el banco físico está desconectado.

## Qué es y qué no es

**Modelos portados del firmware**, no inventados:

| Archivo | Porta | Qué reproduce |
|---|---|---|
| `models/odrive.js` | `odrive_virtual.cpp` | Inercia, rampa, **carga hidrodinámica cuadrática**, caída del bus DC, corriente dinámica, potencia, torque, temperatura de FET, máquina de estados de armado |
| `models/controlEngine.js` | `control_engine.cpp` | Orden exacto de decisión: e-stop → MANUAL → sin muestra → **watchdog 35 s** → PID/Fuzzy → saturación 0-600, con anti-windup `I_max = max_rpm/Ki` |
| `models/odLogger.js` | `sensor_engine.cpp` + `measurement_storage.cpp` | Ciclo Modbus del OPTOD, decodificación de float, plausibilidad, escalado a enteros y **modos de fallo** (ceros + `STATUS_OD_SENSOR_BIT`) |
| `models/espnow.js` | `esp_now_packet.h` + `esp_now_rx/sender.cpp` | Trama real, `channel = 0` (auto-seguir al AP), latencia, pérdida y la **frontera de confianza de `status_flags`** |
| `models/masterClock.js` | ADR-3 | Reloj maestro local→UTC, fallback NTP, **desfase por nodo** y extrapolación del nodo sin RTC |

**Fidelidad verificada, no asumida:** `scripts/verify-pid-fidelity.js` compila el
`control_engine.cpp` de **producción** en el host y compara 1080 pasos contra el port en JS →
diferencia máxima **7.3e-05 RPM** (solo redondeo de float32). `scripts/verify-twin-constants.js`
falla si un `config.h` deja de coincidir con el gemelo, de modo que la deriva no puede pasar
inadvertida.

**Lo que NO valida** (solo se prueba en banco): capa física de radio (RSSI, modulación), RS-485 real,
FOC del motor y la hidrodinámica del tanque. Y por la regla 10 de `AGENTS.md`, los resultados del
Capítulo VII salen **exclusivamente del banco físico**: esto es una herramienta de desarrollo y
regresión, nunca una fuente de resultados.

## Uso

```bash
cd Tesis_webpage

# Todos los escenarios contra producción
node scripts/virtual-bench/runner.js

# Un escenario concreto
node scripts/virtual-bench/runner.js --scenario planta2

# Contra el dev server local
node scripts/virtual-bench/runner.js --target local

# Otros
--keep-data   # conserva las filas creadas (por defecto se limpian)
--force       # corre aunque el orquestador no esté en IDLE
--verbose     # trazas detalladas (comandos entrantes y resultado de cada push)
```

## Seguridad de datos

El banco escribe en la base de datos real, así que se protege por diseño:

1. **Se niega a correr** si el orquestador no está en `IDLE` (salvo `--force`), para no interferir
   con un ensayo real.
2. **Snapshot de marcas antes de empezar** y borrado de **exactamente lo que creó**:
   `control_commands` por `created_at` restringido a los 4 nodos canónicos (su clave es UUID, no
   admite rango numérico); el resto por rango de `id`.
3. **Restaura el `system_state` previo** y **elimina los experimentos de prueba** del registro,
   incluso si un escenario falla. Cada escenario además sanea sensor y reloj en un `finally`, para
   que un fallo no provoque fallos en cascada.
4. Informa de las tablas ausentes, que hoy son todas las de archivo de alta fidelidad mientras no se
   aplique `supabase/migrations/20261008_separate_actuator_roles.sql`.

## Escenarios

| Escenario | Qué comprueba |
|---|---|
| `planta1` | Planta 1: `mixer='on'` girando y aireador en `motor_mode='off'` |
| `planta2` | Planta 2: escalón manual al 40 %, mixer detenido y **aireador girando de verdad** |
| `closedloop` | Caso B: PID con setpoint 5.0 y **el PID demanda RPM** con OD bajo |
| `sensorSampling` | El sensor recibe `set_state ACTIVE_EXPERIMENT` (sin esto la curva sale vacía) |
| `manualOverride` | `MANUAL_OVERRIDE` deja los 4 nodos en OFF |
| `estop` | E-Stop latchea a 0 RPM y `clear_estop` lo libera |
| `manualFailsafeGap` | **Caracteriza un hueco real**: en MANUAL el watchdog de 35 s NO actúa |
| `espnowTrust` | Con el sensor averiado, el cero fantasma NO entra al lazo y el watchdog frena |
| `ingestion` | La telemetría persiste en la BD (cuenta filas nuevas) |
| `channelAlignment` | Un canal ESP-NOW desalineado pierde el 100 % de los paquetes |
| `clockSkew` | Con 12 s de desfase el backend lo detecta y ancla al servidor |

Todos los escenarios incluyen además una **aserción transversal**: ningún nodo puede recibir
acciones de otro rol (entrega cruzada).

## Fidelidad de los nodos

- **Cadencia real**: sensor 0.2 Hz, aireador 5 Hz de muestreo y lote cada 5 s, heartbeat de 20 s en
  IDLE, polling de comandos cada 1.5 s (1 s en MANUAL).
- **Endpoints y campos idénticos** al firmware (`buildSampleObject`, `sendTelemetryBatch`,
  telemetría del T-200 y `postPumpEvent`).
- **ACK con `rtc_timestamp_ms`** del instante de ejecución, para el anclaje por latencia.
- El aireador **no calcula la planta**: ejecuta el PID real contra la lectura que le llega por
  ESP-NOW. La dinámica del tanque no se simula.

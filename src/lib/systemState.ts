import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';
import { OrchestratorState, SystemState, OverrideFlags, CommandStatus } from '@/types';
import { resolveActuatorRecipe, buildActuatorIntent } from '@/lib/experimentRecipe';

/** Clave canónica en system_settings para el estado global del orquestador (AquaControl V4). */
export const ORCHESTRATOR_KEY = 'system_state';

/** Registro canónico de nodos del banco de pruebas. */
export const DEVICE_IDS = {
  sensor: 'a0000000-0000-0000-0000-000000000001',
  odrive: 'b0000000-0000-0000-0000-000000000002',
  mixer: 'c0000000-0000-0000-0000-000000000003',
  pump: 'd0000000-0000-0000-0000-000000000004'
} as const;

export type DeviceRole = keyof typeof DEVICE_IDS;

export const ALL_DEVICE_IDS: string[] = Object.values(DEVICE_IDS);

const IDLE_OVERRIDE: OverrideFlags = { master: false, pump: false, mixer: false, odrive: false };

export const DEFAULT_SYSTEM_STATE: SystemState = {
  state: 'IDLE',
  since: new Date(0).toISOString(),
  experiment_id: null,
  override: IDLE_OVERRIDE,
  updated_by: 'system'
};

const VALID_STATES: OrchestratorState[] = ['IDLE', 'ACTIVE_EXPERIMENT', 'MANUAL_OVERRIDE'];

export function normalizeSystemState(raw: any): SystemState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SYSTEM_STATE };
  const state: OrchestratorState = VALID_STATES.includes(raw.state) ? raw.state : 'IDLE';
  return {
    state,
    since: typeof raw.since === 'string' && raw.since ? raw.since : new Date().toISOString(),
    experiment_id: raw.experiment_id ?? null,
    override: { ...IDLE_OVERRIDE, ...(raw.override || {}) },
    updated_by: typeof raw.updated_by === 'string' ? raw.updated_by : 'system'
  };
}

/** Lee el estado global. Devuelve IDLE por defecto si la BD no está configurada o la clave no existe. */
export async function getSystemState(): Promise<SystemState> {
  if (!isSupabaseConfigured()) return { ...DEFAULT_SYSTEM_STATE };
  try {
    const { data, error } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', ORCHESTRATOR_KEY)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_SYSTEM_STATE };
    return normalizeSystemState(data.value);
  } catch {
    return { ...DEFAULT_SYSTEM_STATE };
  }
}

/** Escribe (upsert) el estado global. `since` se refresca cuando cambia el estado o el experimento. */
export async function setSystemState(patch: Partial<SystemState> & { updated_by?: string }): Promise<SystemState> {
  const current = await getSystemState();
  const next: SystemState = {
    ...current,
    ...patch,
    override: { ...current.override, ...(patch.override || {}) }
  };
  const stateChanged = next.state !== current.state || next.experiment_id !== current.experiment_id;
  if (stateChanged) next.since = new Date().toISOString();
  next.updated_by = patch.updated_by || current.updated_by;

  if (isSupabaseConfigured()) {
    await supabaseAdmin.from('system_settings').upsert(
      {
        key: ORCHESTRATOR_KEY,
        value: next,
        description: 'Estado global del orquestador AquaControl (IDLE | ACTIVE_EXPERIMENT | MANUAL_OVERRIDE)',
        updated_at: new Date().toISOString()
      },
      { onConflict: 'key' }
    );
  }
  return next;
}

export interface EnqueueCommandInput {
  device_id: string;
  /**
   * Solo los tipos permitidos por el CHECK de `control_commands` en producción
   * (`start`, `stop`, `set_speed`, `emergency_stop`, `reboot`). La intención semántica
   * viaja en `payload.action`, que el firmware interpreta con prioridad.
   */
  command_type: 'start' | 'stop' | 'set_speed' | 'emergency_stop' | 'reboot';
  payload?: Record<string, any>;
  speed_percent?: number;
  requested_by?: string;
}

/**
 * Inserta una orden en control_commands replicando la estrategia de robustez del endpoint /api/commands:
 * si la columna `payload` no está disponible, serializa el JSON en `error_message`.
 */
export async function enqueueCommand(input: EnqueueCommandInput): Promise<{ id: string; status: CommandStatus } | null> {
  if (!isSupabaseConfigured()) return null;

  const payload = { ...(input.payload || {}) };
  if (!payload.action) payload.action = input.command_type;
  const actionTag = String(payload.action);
  const requested_by = input.requested_by && input.requested_by.includes('(')
    ? input.requested_by
    : `${input.requested_by || 'Orquestador'} (${actionTag})`;

  const speed = Math.max(0, Math.min(100, Number(input.speed_percent ?? 0)));
  const base: Record<string, any> = {
    device_id: input.device_id,
    command_type: input.command_type,
    speed_percent: speed,
    pwm_us: Math.round(1500 + (speed / 100) * 400),
    status: 'pending',
    requested_by
  };

  let res = await supabaseAdmin
    .from('control_commands')
    .insert({ ...base, payload })
    .select('id, status')
    .single();

  if (res.error) {
    // Fallback histórico: la columna payload puede no existir en algunas instalaciones.
    res = await supabaseAdmin
      .from('control_commands')
      .insert({ ...base, error_message: JSON.stringify(payload) })
      .select('id, status')
      .single();
  }

  if (res.error || !res.data) {
    console.error('enqueueCommand error:', res.error);
    return null;
  }
  return { id: res.data.id, status: res.data.status };
}

/** Lee el experimento del registro canónico (`system_settings.experiments_registry`). */
export async function getRegisteredExperiment(experimentId: string | null): Promise<any | null> {
  if (!experimentId || !isSupabaseConfigured()) return null;
  try {
    const { data } = await supabaseAdmin
      .from('system_settings')
      .select('value')
      .eq('key', 'experiments_registry')
      .maybeSingle();
    const list = Array.isArray(data?.value) ? data.value : [];
    return list.find((e: any) => e?.id === experimentId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Difunde un `set_state` a todos los nodos del banco. Devuelve cuántas órdenes se encolaron.
 *
 * El payload incluye la intención EXPLÍCITA de cada actuador, resuelta desde el registro de
 * experimentos. Sin ella cada nodo adivinaba: el T-200 encendía el mixer en todo
 * `ACTIVE_EXPERIMENT` y el ODrive no se armaba nunca. En IDLE / MANUAL_OVERRIDE la receta se
 * fuerza a OFF porque una anulación manual debe abortar cualquier automatismo (ADD §2.3).
 */
export async function broadcastState(state: SystemState, requested_by: string): Promise<number> {
  const experiment = await getRegisteredExperiment(state.experiment_id);
  const intent = buildActuatorIntent(state.state, resolveActuatorRecipe(experiment));

  let queued = 0;
  for (const device_id of ALL_DEVICE_IDS) {
    const isSensor = device_id === DEVICE_IDS.sensor;

    // La intención se envía solo al nodo que la ejecuta, para no dejar ambigüedad entre nodos.
    const roleIntent: Record<string, string | number> = {};
    if (device_id === DEVICE_IDS.mixer) {
      roleIntent.mixer = intent.mixer as string;
    }
    if (device_id === DEVICE_IDS.odrive) {
      roleIntent.motor_mode = intent.motor_mode as string;
      if (intent.motor_target_do !== undefined) roleIntent.motor_target_do = intent.motor_target_do;
      if (intent.motor_throttle_pct !== undefined) roleIntent.motor_throttle_pct = intent.motor_throttle_pct;
    }

    const cmd = await enqueueCommand({
      device_id,
      // `set_speed` es el tipo permitido por el CHECK de producción para actuadores;
      // el significado real viaja en payload.action = 'set_state'.
      command_type: isSensor ? (state.state === 'IDLE' ? 'stop' : 'start') : 'set_speed',
      payload: {
        action: 'set_state',
        state: state.state,
        experiment_id: state.experiment_id,
        override: state.override,
        interval_sec: 5,
        ...roleIntent
      },
      requested_by
    });
    if (cmd) queued++;
  }
  return queued;
}

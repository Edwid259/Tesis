// Definición de tipos de datos para AquaControl IoT & Supabase

export type DeviceType = 'sensor_do' | 'motor_thruster' | 'gateway';
export type DeviceStatus = 'online' | 'offline' | 'warning' | 'error';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'activa' | 'reconocida' | 'resuelta';
export type CommandStatus = 'pending' | 'sent' | 'acknowledged' | 'failed' | 'expired';
export type EventSource = 'manual' | 'automatic' | 'system' | 'emergency';

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  api_key_hash?: string;
  location: string;
  status: DeviceStatus;
  last_seen_at: string | null;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at?: string;
}

export interface SensorReading {
  id?: number;
  device_id: string;
  recorded_at: string;
  seconds_since_2000?: number;
  // Oxígeno Disuelto
  dissolved_oxygen_raw: number;
  dissolved_oxygen_mg_l: number;
  // Saturación
  oxygen_saturation_raw?: number;
  oxygen_saturation_pct?: number;
  // Temperatura
  water_temperature_raw: number;
  water_temperature_c: number;
  // Parámetros crudos adicionales
  param3_raw?: number;
  param4_raw?: number;
  // Batería
  battery_mv?: number;
  battery_v?: number;
  // RTC
  rtc_temperature_raw?: number;
  rtc_temperature_c?: number;
  status?: number;
  sent?: boolean;
  created_at?: string;
}

export interface MotorTelemetry {
  id?: number;
  device_id: string;
  recorded_at: string;
  is_on: boolean;
  speed_percent: number; // 0 - 100%
  pwm_us: number;        // e.g. 1500 (stop), 1760
  voltage_v?: number;
  current_a?: number;
  power_w?: number;
  status_code?: number;
  created_at?: string;
}

export interface MotorEvent {
  id?: number;
  device_id: string;
  started_at: string;
  ended_at?: string | null;
  event_type: 'start' | 'stop' | 'speed_change' | 'warning' | 'error' | 'offline';
  speed_percent: number;
  pwm_us: number;
  source: EventSource;
  notes?: string;
  created_at?: string;
}

export interface Alert {
  id: number;
  device_id: string | null;
  created_at: string;
  alert_type: 'low_do' | 'critical_do' | 'sensor_offline' | 'motor_overtime' | 'communication_error' | 'battery_low' | 'system_error';
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  metadata?: Record<string, any>;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

export interface ControlCommand {
  id: string;
  device_id: string;
  command_type: 'start' | 'stop' | 'set_speed' | 'emergency_stop' | 'reboot';
  speed_percent: number;
  pwm_us: number;
  status: CommandStatus;
  requested_by: string;
  created_at: string;
  sent_at?: string | null;
  executed_at?: string | null;
  error_message?: string | null;
}

export interface SystemThresholds {
  critical: number;  // e.g. 4.0 mg/L
  warning: number;   // e.g. 6.0 mg/L
  optimal: number;   // e.g. 7.5 mg/L
  unit: string;
}

export interface ScaleFactors {
  do_divider: number;      // e.g. 1000.0 (7874 -> 7.874)
  temp_divider: number;    // e.g. 100.0  (2305 -> 23.05)
  sat_divider: number;     // e.g. 10.0   (985 -> 98.5)
  battery_divider: number; // e.g. 1000.0 (4246 -> 4.246)
}

export interface DashboardSummaryResponse {
  sensorDevice: Device | null;
  motorDevice: Device | null;
  latestSensorReading: SensorReading | null;
  latestMotorTelemetry: MotorTelemetry | null;
  thresholds: SystemThresholds;
  activeAlertsCount: number;
  systemHealth: 'optimal' | 'warning' | 'critical' | 'offline';
  isLive: boolean;
}

export interface HistoryDataPoint {
  timestamp: string;
  timeLabel: string;
  dissolved_oxygen_mg_l?: number;
  oxygen_saturation_pct?: number;
  water_temperature_c?: number;
  battery_v?: number;
  motor_speed_percent?: number;
  motor_is_on?: boolean;
  motor_power_w?: number;
}

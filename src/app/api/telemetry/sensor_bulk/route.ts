import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { device, errorResponse } = await authenticateDevice(req, 'sensor_do');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();
    const { experiment_id, payload } = body;
    
    if (!payload || !Array.isArray(payload)) {
       return NextResponse.json({ error: 'Payload must be an array' }, { status: 400 });
    }

    if (isSupabaseConfigured() && device) {
      // 1. Insert into bulk archive table
      const { error: bulkError } = await supabaseAdmin
        .from('sensor_telemetry_bulk')
        .insert({
          experiment_id: experiment_id || 'idle',
          payload_json: payload,
          created_at: new Date().toISOString()
        });
        
      if (bulkError) {
        console.error('Error insertando bulk OD:', bulkError);
      }

      // 2. Map and bulk insert into sensor_readings for real-time dashboard visualization
      const mappedReadings = payload.map(item => {
        const doDivider = 1000.0;
        const tempDivider = 100.0;
        const satDivider = 10.0;
        const batteryDivider = 1000.0;

        return {
          device_id: device.id,
          recorded_at: item.datetime || new Date().toISOString(),
          seconds_since_2000: item.seconds_since_2000,
          dissolved_oxygen_raw: item.do_milli_mg_l,
          dissolved_oxygen_mg_l: item.do_milli_mg_l !== undefined ? Number((item.do_milli_mg_l / doDivider).toFixed(3)) : 0,
          oxygen_saturation_raw: item.do_sat_deci_pct,
          oxygen_saturation_pct: item.do_sat_deci_pct !== undefined ? Number((item.do_sat_deci_pct / satDivider).toFixed(2)) : null,
          water_temperature_raw: item.water_temp_centi,
          water_temperature_c: item.water_temp_centi !== undefined ? Number((item.water_temp_centi / tempDivider).toFixed(2)) : 0,
          param3_raw: item.param3_centi,
          param4_raw: item.param4_centi,
          battery_mv: item.battery_mv,
          battery_v: item.battery_mv !== undefined ? Number((item.battery_mv / batteryDivider).toFixed(2)) : null,
          rtc_temperature_raw: item.rtc_temp_centi,
          rtc_temperature_c: item.rtc_temp_centi !== undefined ? Number((item.rtc_temp_centi / tempDivider).toFixed(2)) : null,
          status: item.status || 0,
          sent: item.sent !== undefined ? item.sent : true
        };
      });

      if (mappedReadings.length > 0) {
        const { error: insertError } = await supabaseAdmin
          .from('sensor_readings')
          .insert(mappedReadings);
          
        if (insertError) console.error('Error insertando en sensor_readings:', insertError);
      }

      await supabaseAdmin.from('devices').update({
        status: 'online',
        last_seen_at: new Date().toISOString()
      }).eq('id', device.id);
    }

    let pendingCommand: any = null;
    if (isSupabaseConfigured() && device) {
      const { data: cmdRows } = await supabaseAdmin
        .from('control_commands')
        .select('*')
        .eq('device_id', device.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1);

      if (cmdRows && cmdRows.length > 0) {
        let cmdPayload = cmdRows[0].payload;
        if (!cmdPayload || typeof cmdPayload !== 'object' || Object.keys(cmdPayload).length === 0) {
           cmdPayload = { action: cmdRows[0].command_type, interval_sec: 5 };
        }
        pendingCommand = { id: cmdRows[0].id, command_type: cmdRows[0].command_type, payload: cmdPayload };
        await supabaseAdmin.from('control_commands').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', cmdRows[0].id);
      }
    }

    return NextResponse.json({
      success: true,
      has_command: Boolean(pendingCommand),
      pending_command: pendingCommand
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'Payload error' }, { status: 400 });
  }
}

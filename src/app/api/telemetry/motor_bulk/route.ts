import { NextRequest, NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/deviceAuth';
import { supabaseAdmin, isSupabaseConfigured } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { device, errorResponse } = await authenticateDevice(req, 'motor_thruster');
  if (errorResponse) return errorResponse;

  try {
    const body = await req.json();
    const { experiment_id, payload } = body;
    
    if (!payload || !Array.isArray(payload)) {
       return NextResponse.json({ error: 'Payload must be an array' }, { status: 400 });
    }

    if (isSupabaseConfigured() && device) {
      let final_experiment_id = experiment_id;
      if (final_experiment_id === 'backend_resolved') {
          const { data: settingRow } = await supabaseAdmin
            .from('system_settings')
            .select('value')
            .eq('key', 'experiments_registry')
            .maybeSingle();

          if (settingRow && Array.isArray(settingRow.value)) {
            const activeExp = settingRow.value.find((e: any) => e.status === 'active');
            final_experiment_id = activeExp ? activeExp.id : 'idle';
          } else {
            final_experiment_id = 'idle';
          }
      }

      const { error: insertError } = await supabaseAdmin
        .from('odrive_telemetry_bulk')
        .insert({
          experiment_id: final_experiment_id || 'idle',
          payload_json: payload,
          created_at: new Date().toISOString()
        });
        
      if (insertError) {
        console.error('Error insertando bulk ODrive:', insertError);
        return NextResponse.json({ error: 'Error DB' }, { status: 500 });
      }

      await supabaseAdmin.from('devices').update({
        status: 'online',
        last_seen_at: new Date().toISOString()
      }).eq('id', device.id);
    }

    return NextResponse.json({
      success: true
    });
  } catch (error: any) {
    return NextResponse.json({ error: 'Payload error' }, { status: 400 });
  }
}

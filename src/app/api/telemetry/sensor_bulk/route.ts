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
      const { error: insertError } = await supabaseAdmin
        .from('sensor_telemetry_bulk')
        .insert({
          experiment_id: experiment_id || 'idle',
          payload_json: payload,
          created_at: new Date().toISOString()
        });
        
      if (insertError) {
        console.error('Error insertando bulk OD:', insertError);
        return NextResponse.json({ error: 'Error DB' }, { status: 500 });
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
        pendingCommand = { id: cmdRows[0].id, command_type: cmdRows[0].command_type };
        // We do NOT mark it sent here immediately if we want real handshake, 
        // but for now, we mark it sent to prevent spam
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

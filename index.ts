import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const PUB = Deno.env.get("VAPID_PUBLIC_KEY")!;
const PRIV = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:bluemoon-days@example.com";
const CRON = Deno.env.get("CRON_SECRET")!;

webpush.setVapidDetails(SUBJECT, PUB, PRIV);
const admin = createClient(URL_, SERVICE);
const authc = createClient(URL_, ANON);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-cron-secret" };

async function send(rows: any[], payload: any) {
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        JSON.stringify(payload),
        { TTL: 3600 }
      );
      sent++;
    } catch (e: any) {
      console.error("push_send_failed", r.id, e?.statusCode, e?.body || e?.message || e);
      if ([404, 410].includes(e?.statusCode)) await admin.from("push_subscriptions").delete().eq("id", r.id);
    }
  }
  return sent;
}

async function user(req: Request) {
  const t = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!t) return null;
  return (await authc.auth.getUser(t)).data.user || null;
}

function bangkokParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  return { y: +get("year"), mo: +get("month"), d: +get("day"), h: +get("hour"), mi: +get("minute") };
}
function pad(n: number) { return String(n).padStart(2, "0"); }
function localDateKey(p: ReturnType<typeof bangkokParts>) { return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
function minuteOfDay(h: number, m: number) { return h * 60 + m; }
function reminderMatchesNow(r: any, now: ReturnType<typeof bangkokParts>) {
  if (!r.reminder_date || !r.reminder_time || !r.is_active || r.is_completed) return false;
  const rawDate = String(r.reminder_date).slice(0, 10);
  const [y, mo, d] = rawDate.split("-").map(Number);
  const tm = String(r.reminder_time).slice(0, 5);
  const [h, m] = tm.split(":").map(Number);
  if (![y, mo, d, h, m].every(Number.isFinite)) return false;

  const repeat = r.repeat_type || "none";
  let dateMatch = now.y === y && now.mo === mo && now.d === d;
  if (repeat === "daily") dateMatch = true;
  if (repeat === "weekly") {
    const base = new Date(Date.UTC(y, mo - 1, d));
    const cur = new Date(Date.UTC(now.y, now.mo - 1, now.d));
    dateMatch = base.getUTCDay() === cur.getUTCDay();
  }
  if (repeat === "monthly") dateMatch = now.d === d;
  if (repeat === "yearly") dateMatch = now.mo === mo && now.d === d;
  if (!dateMatch) return false;

  // Match the current Bangkok minute only. Cron runs once per minute; using a wide window
  // can make a reminder arrive early/late or be retried unexpectedly.
  return minuteOfDay(now.h, now.mi) === minuteOfDay(h, m);
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json();

    if (b.type === "reminders") {
      if (req.headers.get("x-cron-secret") !== CRON) return new Response("Unauthorized", { status: 401, headers: cors });

      const now = new Date();
      const bp = bangkokParts(now);
      const { data: rs, error } = await admin.from("reminders")
        .select("id,couple_id,title,reminder_date,reminder_time,repeat_type,is_active,is_completed,last_notified_at")
        .eq("is_active", true).eq("is_completed", false);
      if (error) throw error;

      let matched = 0, skippedRecentlyNotified = 0, sent = 0, completed = 0;
      for (const r of rs || []) {
        if (!reminderMatchesNow(r, bp)) continue;
        matched++;
        // Prevent duplicate runs in the same minute without creating a new SQL column.
        if (r.last_notified_at) {
          const age = now.getTime() - new Date(r.last_notified_at).getTime();
          if (age >= 0 && age < 90 * 1000) { skippedRecentlyNotified++; continue; }
        }

        const { data: subs, error: subErr } = await admin.from("push_subscriptions")
          .select("id,endpoint,p256dh,auth").eq("couple_id", r.couple_id);
        if (subErr) throw subErr;

        const n = await send(subs || [], {
          title: "⏰ " + r.title,
          body: "ถึงเวลาแล้ว 💙",
          tag: "reminder-" + r.id,
          renotify: true
        });
        sent += n;

        // Mark the notification attempt time even if there are no current subscriptions,
        // so an empty device list does not cause repeated processing within the same minute.
        await admin.from("reminders").update({ last_notified_at: now.toISOString() }).eq("id", r.id);

        if ((r.repeat_type || "none") === "none") {
          await admin.from("reminders").update({ is_completed: true }).eq("id", r.id);
          completed++;
        }
      }

      console.log("reminders", {
        bangkok: `${localDateKey(bp)} ${pad(bp.h)}:${pad(bp.mi)}`,
        total: (rs || []).length, matched, skippedRecentlyNotified, sent, completed
      });
      return new Response(JSON.stringify({ ok: true, matched, skippedRecentlyNotified, sent, completed }), {
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    const u = await user(req);
    if (!u) return new Response("Unauthorized", { status: 401, headers: cors });

    if (b.type === "subscribe") {
      const member = await admin.from("couple_members").select("user_id").eq("couple_id", b.couple_id).eq("user_id", u.id).maybeSingle();
      if (member.error) throw member.error;
      if (!member.data) return new Response("Forbidden", { status: 403, headers: cors });
      if (!b.endpoint || !b.p256dh || !b.auth) return new Response(JSON.stringify({ok:false,error:"Push subscription data is incomplete"}), { status: 400, headers: {...cors, "Content-Type":"application/json"} });
      const { error: upErr } = await admin.from("push_subscriptions").upsert({
        user_id: u.id, couple_id: b.couple_id, endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth, user_agent: b.user_agent || null, updated_at: new Date().toISOString()
      }, { onConflict: "endpoint" });
      if (upErr) throw upErr;
      return new Response(JSON.stringify({ok:true}), { headers: {...cors, "Content-Type":"application/json"} });
    }

    if (b.type === "test") {
      const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", u.id).eq("couple_id", b.couple_id);
      const sent = await send(subs || [], { title: "💙 BlueMoon Days", body: "Push จากเซิร์ฟเวอร์ทำงานแล้ว 🎉", tag: "server-test", renotify: true });
      return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (b.type === "message") {
      if (b.sender_id !== u.id) return new Response("Forbidden", { status: 403, headers: cors });
      const { data: mem } = await admin.from("couple_members").select("user_id").eq("couple_id", b.couple_id).neq("user_id", u.id);
      const ids = (mem || []).map((x: any) => x.user_id);
      const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth").in("user_id", ids).eq("couple_id", b.couple_id);
      const sent = await send(subs || [], { title: "💬 BlueMoon Days", body: b.content || "ข้อความใหม่", tag: "chat-" + b.message_id, renotify: true });
      return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response("Bad request", { status: 400, headers: cors });
  } catch (e: any) {
    console.error("send-push_error", e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

// /Users/eriks/Desktop/FreakSlots/backend/telegramBot.js
import TelegramBot from "node-telegram-bot-api";
import util from "node:util";
import { db } from "./firebase.js";

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

function normalizeBaseUrl(url) {
    // remove trailing slashes to avoid // in webhook URL
    return String(url || "").replace(/\/+$/, "");
}

const ADMIN_USER_IDS = (process.env.TG_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

function isAdmin(userId) {
    return ADMIN_USER_IDS.includes(Number(userId));
}

async function addUser(userId, username) {
    const firestore = db();
    await firestore.collection("users").doc(String(userId)).set(
        {
            id: Number(userId),
            username: username || "",
            updatedAt: new Date().toISOString(),
        },
        { merge: true }
    );
}

async function getAllUsers() {
    const firestore = db();
    const snap = await firestore.collection("users").get();
    return snap.docs.map((d) => d.data()?.id).filter(Boolean);
}

function logFullError(prefix, err) {
    console.error(prefix);
    console.error("message:", err?.message);
    console.error("code:", err?.code);
    console.error("name:", err?.name);

    // Telegram API details usually live here
    const body =
        err?.response?.body ||
        err?.response?.data ||
        err?.body ||
        err?.response;

    if (body) {
        console.error("telegram body:", typeof body === "string" ? body : util.inspect(body, { depth: 10 }));
    }

    if (err?.stack) console.error("stack:", err.stack);

    // If everything above is missing, print a trimmed inspect
    console.error("inspect:", util.inspect(err, { depth: 4 }));
}

function makeId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const SCHEDULE_TIME_ZONE = "Europe/Riga";
const tzPartsFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});

function getTimeZoneParts(ts) {
    const map = {};
    for (const p of tzPartsFormatter.formatToParts(new Date(ts))) {
        if (p.type !== "literal") map[p.type] = p.value;
    }
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
    };
}

function getTimeZoneOffsetMs(ts) {
    const p = getTimeZoneParts(ts);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    return asUtc - ts;
}

function wallTimeToUtcMs(year, month, day, hour, minute) {
    const baseUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    let ts = baseUtc;

    // Iterate to stabilize offset around DST boundaries.
    for (let i = 0; i < 3; i += 1) {
        const offset = getTimeZoneOffsetMs(ts);
        const nextTs = baseUtc - offset;
        if (nextTs === ts) break;
        ts = nextTs;
    }

    // Reject impossible wall-times (for DST jumps).
    const check = getTimeZoneParts(ts);
    if (
        check.year !== year ||
        check.month !== month ||
        check.day !== day ||
        check.hour !== hour ||
        check.minute !== minute
    ) {
        return null;
    }

    return ts;
}

function parseDateTimeLocal(input) {
    // expected: YYYY-MM-DD HH:mm
    const m = String(input || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, y, mo, d, h, mi] = m;

    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    const minute = Number(mi);
    if (
        !Number.isInteger(year) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31 ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) return null;

    const ts = wallTimeToUtcMs(year, month, day, hour, minute);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts);
}

function parseHHMM(input) {
    const m = String(input || "").trim().match(/^(\d{2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return { hh, mm, label: `${m[1]}:${m[2]}` };
}

function nextDailyRunAt(hh, mm, from = new Date()) {
    const nowMs = from.getTime();
    const nowParts = getTimeZoneParts(nowMs);
    const dayStartUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 0, 0, 0, 0);

    for (let i = 0; i < 14; i += 1) {
        const d = new Date(dayStartUtc + i * 24 * 60 * 60 * 1000);
        const ts = wallTimeToUtcMs(
            d.getUTCFullYear(),
            d.getUTCMonth() + 1,
            d.getUTCDate(),
            hh,
            mm
        );
        if (!Number.isFinite(ts)) continue;
        if (ts > nowMs) return ts;
    }

    return nowMs + 24 * 60 * 60 * 1000;
}

function fmtTs(ts) {
    const p = getTimeZoneParts(ts);
    return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} (Riga)`;
}

function payloadPreviewText(payload, maxLen = 80) {
    const raw = payload?.text || payload?.caption || "";
    const oneLine = String(raw).replace(/\s+/g, " ").trim();
    if (oneLine) return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;

    if (payload?.photoFileId) return "Photo";
    if (payload?.videoFileId) return "Video";
    if (payload?.videoNoteFileId) return "Video note";
    if (payload?.documentFileId) return "Document";
    if (payload?.audioFileId) return "Audio";
    return "Message";
}

/**
 * Call this from server.js:
 *   import { initTelegramBot } from "./telegramBot.js";
 *   ...
 *   app.use(express.json());
 *   initTelegramBot(app);
 */
export function initTelegramBot(app) {
    const token = requireEnv("TELEGRAM_BOT_TOKEN");
    const publicBaseUrl = normalizeBaseUrl(requireEnv("PUBLIC_BASE_URL"));
    const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
    const webAppUrl = requireEnv("TG_WEBAPP_URL"); // required for /start button

    const bot = new TelegramBot(token, { polling: false });

    bot.on("error", (err) => logFullError("telegram bot error:", err));
    bot.on("webhook_error", (err) => logFullError("telegram webhook_error:", err));

    // Webhook endpoint Telegram will POST updates to
    app.post(`/telegram/webhook/${webhookSecret}`, (req, res) => {
        try {
            // If you do not see this line when sending /start, Telegram is not reaching your backend
            console.log("Telegram update received:", JSON.stringify(req.body));
            bot.processUpdate(req.body);
            res.sendStatus(200);
        } catch (err) {
            logFullError("processUpdate failed:", err);
            // Still return 200 so Telegram does not retry aggressively
            res.sendStatus(200);
        }
    });

    // Register webhook with Telegram
    const webhookUrl = `${publicBaseUrl}/telegram/webhook/${webhookSecret}`;
    bot
        .setWebHook(webhookUrl)
        .then(() => console.log("Telegram webhook set to:", webhookUrl))
        .catch((err) => logFullError("Failed to set Telegram webhook:", err));

    // Temporary in-memory stores (reset on restart)
    const broadcastState = new Map(); // adminChatId -> state object
    const scheduledBroadcasts = new Map(); // scheduleId -> schedule object
    const scheduleInFlight = new Set();
    let schedulerBusy = false;

    function isSupportedPayload(payload) {
        return Boolean(
            payload?.text ||
            payload?.photoFileId ||
            payload?.videoFileId ||
            payload?.videoNoteFileId ||
            payload?.documentFileId ||
            payload?.audioFileId
        );
    }

    function extractPayload(chatId, msg) {
        return {
            sourceChatId: chatId,
            sourceMessageId: msg.message_id,
            text: msg.text || null,
            textEntities: Array.isArray(msg.entities) ? msg.entities : null,
            caption: msg.caption || null,
            captionEntities: Array.isArray(msg.caption_entities) ? msg.caption_entities : null,
            photoFileId: msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null,
            videoFileId: msg.video?.file_id || null,
            videoNoteFileId: msg.video_note?.file_id || null,
            documentFileId: msg.document?.file_id || null,
            audioFileId: msg.audio?.file_id || null,
        };
    }

    async function sendPayloadToUser(targetChatId, payload) {
        if (payload.sourceChatId && payload.sourceMessageId) {
            try {
                await bot.copyMessage(targetChatId, payload.sourceChatId, payload.sourceMessageId);
                return;
            } catch (err) {
                // fallback below
                logFullError("copyMessage failed, using fallback:", err);
            }
        }

        if (payload.text) {
            await bot.sendMessage(targetChatId, payload.text, {
                entities: payload.textEntities || undefined,
            });
            return;
        }

        const captionEntities = payload.captionEntities
            ? JSON.stringify(payload.captionEntities)
            : undefined;

        if (payload.photoFileId) {
            await bot.sendPhoto(targetChatId, payload.photoFileId, {
                caption: payload.caption || "",
                caption_entities: captionEntities,
            });
            return;
        }

        if (payload.videoFileId) {
            await bot.sendVideo(targetChatId, payload.videoFileId, {
                caption: payload.caption || "",
                caption_entities: captionEntities,
            });
            return;
        }

        if (payload.videoNoteFileId) {
            await bot.sendVideoNote(targetChatId, payload.videoNoteFileId);
            return;
        }

        if (payload.documentFileId) {
            await bot.sendDocument(targetChatId, payload.documentFileId, {
                caption: payload.caption || "",
                caption_entities: captionEntities,
            });
            return;
        }

        if (payload.audioFileId) {
            await bot.sendAudio(targetChatId, payload.audioFileId, {
                caption: payload.caption || "",
                caption_entities: captionEntities,
            });
            return;
        }

        throw new Error("Unsupported message payload");
    }

    async function sendBroadcastNow(payload) {
        let userIds = [];
        try {
            userIds = await getAllUsers();
        } catch (err) {
            logFullError("getAllUsers failed:", err);
            throw new Error("Failed to load users from database.");
        }

        let sent = 0;
        for (const userId of userIds) {
            try {
                await sendPayloadToUser(userId, payload);
                sent += 1;
            } catch {
                // ignore blocked users / failures
            }
        }
        return { sent, total: userIds.length };
    }

    function scheduleSummary(s) {
        if (s.mode === "once") return `One-time at ${fmtTs(s.nextRunAt)}`;
        return `Daily at ${s.dailyTime} (next: ${fmtTs(s.nextRunAt)})`;
    }

    async function showScheduledList(chatId) {
        const list = [...scheduledBroadcasts.values()]
            .filter((s) => s.adminChatId === chatId && s.status === "active")
            .sort((a, b) => a.nextRunAt - b.nextRunAt);

        if (!list.length) {
            await bot.sendMessage(chatId, "No active scheduled broadcasts.");
            return;
        }

        await bot.sendMessage(chatId, "Scheduled broadcasts:");

        for (const s of list) {
            // Show actual content preview first, then actions.
            try {
                await sendPayloadToUser(chatId, s.payload);
            } catch {
                await bot.sendMessage(chatId, payloadPreviewText(s.payload));
            }

            await bot.sendMessage(
                chatId,
                `${s.mode === "once" ? "One-time" : "Daily"} • ${fmtTs(s.nextRunAt)}\n${payloadPreviewText(s.payload)}`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Open", callback_data: `sched_open:${s.id}` }],
                            [{ text: "Cancel", callback_data: `sched_cancel:${s.id}` }],
                        ],
                    },
                }
            );
        }

        await bot.sendMessage(chatId, "End of scheduled broadcasts.", {
            reply_markup: {
                inline_keyboard: [[{ text: "Refresh", callback_data: "sched_list" }]],
            },
        });
    }

    async function showScheduleDetails(chatId, scheduleId) {
        const s = scheduledBroadcasts.get(scheduleId);
        if (!s || s.adminChatId !== chatId || s.status !== "active") {
            await bot.sendMessage(chatId, "Schedule not found or no longer active.");
            return;
        }

        try {
            await sendPayloadToUser(chatId, s.payload);
        } catch {
            await bot.sendMessage(chatId, payloadPreviewText(s.payload));
        }

        await bot.sendMessage(
            chatId,
            `Type: ${s.mode}\nWhen: ${scheduleSummary(s)}\nPreview: ${payloadPreviewText(s.payload)}`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Cancel schedule", callback_data: `sched_cancel:${s.id}` }],
                        [{ text: "Edit time", callback_data: `sched_edit:${s.id}` }],
                        [{ text: "Replace message", callback_data: `sched_replace:${s.id}` }],
                        [{ text: "Back to list", callback_data: "sched_list" }],
                    ],
                },
            }
        );
    }

    async function runSchedulerTick() {
        if (schedulerBusy) return;
        schedulerBusy = true;

        try {
            const now = Date.now();
            const due = [...scheduledBroadcasts.values()].filter(
                (s) => s.status === "active" && s.nextRunAt <= now && !scheduleInFlight.has(s.id)
            );

            for (const s of due) {
                scheduleInFlight.add(s.id);
                try {
                    const result = await sendBroadcastNow(s.payload);
                    s.lastRunAt = Date.now();

                    if (s.mode === "once") {
                        s.status = "completed";
                    } else {
                        const t = parseHHMM(s.dailyTime);
                        s.nextRunAt = nextDailyRunAt(t.hh, t.mm, new Date(Date.now() + 1000));
                    }

                    await bot.sendMessage(
                        s.adminChatId,
                        `Scheduled broadcast ${s.id} sent.\nDelivered to ${result.sent} users.`
                    );
                } catch (err) {
                    logFullError(`scheduled broadcast failed (${s.id}):`, err);
                    await bot.sendMessage(
                        s.adminChatId,
                        `Scheduled broadcast ${s.id} failed: ${String(err.message || err)}`
                    );
                    if (s.mode === "once") s.status = "failed";
                } finally {
                    scheduleInFlight.delete(s.id);
                }
            }
        } finally {
            schedulerBusy = false;
        }
    }

    setInterval(() => {
        runSchedulerTick().catch((err) => logFullError("scheduler tick failed:", err));
    }, 15000);

    function sendModeKeyboard() {
        return {
            inline_keyboard: [
                [{ text: "Send Now", callback_data: "bc_send_now" }],
                [{ text: "Schedule message", callback_data: "bc_schedule_once" }],
                [{ text: "Schedule and repeat", callback_data: "bc_schedule_daily" }],
                [{ text: "View scheduled", callback_data: "sched_list" }],
                [{ text: "Cancel draft", callback_data: "bc_cancel_draft" }],
            ],
        };
    }

    // /start
    bot.onText(/^\/start(?:\s|$)/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from?.username || "";

        try {
            await addUser(chatId, username);

            const imageUrl = process.env.TG_WELCOME_IMAGE_URL; // optional

            const caption = "👋 Welcome, " + `${username}` + "!\n\n🎰 Wanna spin without risk?\nPlay free demo slots only inside this bot\n\n🏆 Top-rated games & working providers always available\n\n💎 Hidden bonuses & special offers unlocked for players\n\n🔥 Best slots updated daily — don’t miss hot games\n\n👇 Hit play now & start spinning";

            const reply_markup = {
                inline_keyboard: [[{ text: "Play Now", web_app: { url: webAppUrl } }]],
            };

            try {
                if (imageUrl) {
                    await bot.sendPhoto(chatId, imageUrl, { caption, reply_markup });
                } else {
                    await bot.sendMessage(chatId, caption, { reply_markup });
                }
            } catch (err) {
                logFullError("failed to reply to /start:", err);
                throw err;
            }
        } catch (err) {
            logFullError("start handler failed:", err);
            // Try to send something even if DB fails
            try {
                await bot.sendMessage(chatId, "An error occurred. Please try again later.");
            } catch (e2) {
                logFullError("failed to send fallback message:", e2);
            }
        }
    });

    // /broadcast (admin only)
    bot.onText(/^\/broadcast(?:\s|$)/, async (msg) => {
        const chatId = msg.chat.id;
        if (!isAdmin(chatId)) {
            await bot.sendMessage(chatId, "You are not authorized to broadcast.");
            return;
        }

        broadcastState.set(chatId, { step: "waiting_for_message" });
        await bot.sendMessage(
            chatId,
            "Send the message you want to broadcast (text, photo, video, document, audio)."
        );
    });

    // /scheduled (admin only)
    bot.onText(/^\/scheduled(?:\s|$)/, async (msg) => {
        const chatId = msg.chat.id;
        if (!isAdmin(chatId)) return;
        await showScheduledList(chatId);
    });

    // Admin message state machine
    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;
        if (!isAdmin(chatId)) return;

        const state = broadcastState.get(chatId);
        if (!state) return;

        if (typeof msg.text === "string" && msg.text.startsWith("/")) return;

        if (state.step === "waiting_for_message") {
            const payload = extractPayload(chatId, msg);
            if (!isSupportedPayload(payload)) {
                await bot.sendMessage(chatId, "Unsupported type. Send text/photo/video/document/audio.");
                return;
            }

            broadcastState.set(chatId, { step: "choosing_delivery", payload });

            try {
                await sendPayloadToUser(chatId, payload); // preview
                await bot.sendMessage(chatId, "Choose delivery mode:", {
                    reply_markup: sendModeKeyboard(),
                });
            } catch (err) {
                logFullError("broadcast preview failed:", err);
                broadcastState.delete(chatId);
                await bot.sendMessage(chatId, "Preview failed. Please send /broadcast and try again.");
            }
            return;
        }

        if (state.step === "waiting_for_schedule_once_at") {
            const dt = parseDateTimeLocal(msg.text || "");
            if (!dt || dt.getTime() <= Date.now()) {
                await bot.sendMessage(chatId, "Invalid datetime. Use: YYYY-MM-DD HH:mm in Riga time (future time).");
                return;
            }

            const id = makeId();
            scheduledBroadcasts.set(id, {
                id,
                adminChatId: chatId,
                payload: state.payload,
                mode: "once",
                nextRunAt: dt.getTime(),
                dailyTime: null,
                status: "active",
                createdAt: Date.now(),
                lastRunAt: null,
            });

            broadcastState.delete(chatId);
            await bot.sendMessage(chatId, `Scheduled (one-time).\nID: ${id}\nRun at: ${fmtTs(dt.getTime())}`);
            return;
        }

        if (state.step === "waiting_for_schedule_daily_at") {
            const t = parseHHMM(msg.text || "");
            if (!t) {
                await bot.sendMessage(chatId, "Invalid time. Use HH:mm (24h) in Riga time, e.g. 09:30");
                return;
            }

            const id = makeId();
            scheduledBroadcasts.set(id, {
                id,
                adminChatId: chatId,
                payload: state.payload,
                mode: "daily",
                nextRunAt: nextDailyRunAt(t.hh, t.mm),
                dailyTime: t.label,
                status: "active",
                createdAt: Date.now(),
                lastRunAt: null,
            });

            broadcastState.delete(chatId);
            await bot.sendMessage(chatId, `Scheduled (daily).\nID: ${id}\nNext run: ${fmtTs(scheduledBroadcasts.get(id).nextRunAt)}`);
            return;
        }

        if (state.step === "waiting_for_edit_time") {
            const s = scheduledBroadcasts.get(state.scheduleId);
            if (!s || s.adminChatId !== chatId || s.status !== "active") {
                broadcastState.delete(chatId);
                await bot.sendMessage(chatId, "Schedule no longer available.");
                return;
            }

            if (s.mode === "once") {
                const dt = parseDateTimeLocal(msg.text || "");
                if (!dt || dt.getTime() <= Date.now()) {
                    await bot.sendMessage(chatId, "Invalid datetime. Use: YYYY-MM-DD HH:mm in Riga time (future time).");
                    return;
                }
                s.nextRunAt = dt.getTime();
            } else {
                const t = parseHHMM(msg.text || "");
                if (!t) {
                    await bot.sendMessage(chatId, "Invalid time. Use HH:mm (24h) in Riga time, e.g. 09:30");
                    return;
                }
                s.dailyTime = t.label;
                s.nextRunAt = nextDailyRunAt(t.hh, t.mm);
            }

            broadcastState.delete(chatId);
            await bot.sendMessage(chatId, `Schedule updated.\n${scheduleSummary(s)}`);
            return;
        }

        if (state.step === "waiting_for_replace_message") {
            const s = scheduledBroadcasts.get(state.scheduleId);
            if (!s || s.adminChatId !== chatId || s.status !== "active") {
                broadcastState.delete(chatId);
                await bot.sendMessage(chatId, "Schedule no longer available.");
                return;
            }

            const payload = extractPayload(chatId, msg);
            if (!isSupportedPayload(payload)) {
                await bot.sendMessage(chatId, "Unsupported type. Send text/photo/video/document/audio.");
                return;
            }

            s.payload = payload;
            broadcastState.delete(chatId);

            await bot.sendMessage(chatId, `Message content replaced for schedule ${s.id}.`);
            await sendPayloadToUser(chatId, s.payload);
            return;
        }
    });

    // Callback actions
    bot.on("callback_query", async (callbackQuery) => {
        const chatId = callbackQuery.message?.chat?.id;
        const data = callbackQuery.data || "";
        if (!chatId || !isAdmin(chatId)) return;

        if (callbackQuery.id) {
            bot.answerCallbackQuery(callbackQuery.id).catch(() => { });
        }

        const state = broadcastState.get(chatId);

        if (data === "bc_cancel_draft") {
            broadcastState.delete(chatId);
            await bot.sendMessage(chatId, "Draft cancelled.");
            return;
        }

        if (data === "bc_send_now") {
            if (!state || state.step !== "choosing_delivery") return;

            const payload = state.payload;
            broadcastState.delete(chatId);

            try {
                const result = await sendBroadcastNow(payload);
                await bot.sendMessage(chatId, `Broadcast completed. Delivered to ${result.sent} users.`);
            } catch (err) {
                await bot.sendMessage(chatId, `Broadcast failed: ${String(err.message || err)}`);
            }
            return;
        }

        if (data === "bc_schedule_once") {
            if (!state || state.step !== "choosing_delivery") return;
            broadcastState.set(chatId, { step: "waiting_for_schedule_once_at", payload: state.payload });
            await bot.sendMessage(chatId, "Send datetime in format: YYYY-MM-DD HH:mm (Riga time)");
            return;
        }

        if (data === "bc_schedule_daily") {
            if (!state || state.step !== "choosing_delivery") return;
            broadcastState.set(chatId, { step: "waiting_for_schedule_daily_at", payload: state.payload });
            await bot.sendMessage(chatId, "Send daily time in format: HH:mm (24h, Riga time)");
            return;
        }

        if (data === "sched_list") {
            await showScheduledList(chatId);
            return;
        }

        if (data.startsWith("sched_open:")) {
            const scheduleId = data.slice("sched_open:".length);
            await showScheduleDetails(chatId, scheduleId);
            return;
        }

        if (data.startsWith("sched_cancel:")) {
            const scheduleId = data.slice("sched_cancel:".length);
            const s = scheduledBroadcasts.get(scheduleId);
            if (!s || s.adminChatId !== chatId || s.status !== "active") {
                await bot.sendMessage(chatId, "Schedule not found.");
                return;
            }
            s.status = "cancelled";
            await bot.sendMessage(chatId, `Schedule ${scheduleId} cancelled.`);
            return;
        }

        if (data.startsWith("sched_edit:")) {
            const scheduleId = data.slice("sched_edit:".length);
            const s = scheduledBroadcasts.get(scheduleId);
            if (!s || s.adminChatId !== chatId || s.status !== "active") {
                await bot.sendMessage(chatId, "Schedule not found.");
                return;
            }

            broadcastState.set(chatId, { step: "waiting_for_edit_time", scheduleId });
            if (s.mode === "once") {
                await bot.sendMessage(chatId, "Send new datetime: YYYY-MM-DD HH:mm (Riga time)");
            } else {
                await bot.sendMessage(chatId, "Send new daily time: HH:mm (Riga time)");
            }
            return;
        }

        if (data.startsWith("sched_replace:")) {
            const scheduleId = data.slice("sched_replace:".length);
            const s = scheduledBroadcasts.get(scheduleId);
            if (!s || s.adminChatId !== chatId || s.status !== "active") {
                await bot.sendMessage(chatId, "Schedule not found.");
                return;
            }

            broadcastState.set(chatId, { step: "waiting_for_replace_message", scheduleId });
            await bot.sendMessage(chatId, "Send the new message content (text/photo/video/document/audio).");
            return;
        }
    });

    return bot;
}

// Replace these placeholders with your own Supabase project configuration.
// Example:
// const SUPABASE_URL = "https://ltgxcrzsgaompsforfna.supabase.co";
// const SUPABASE_ANON_KEY = "sb_publishable_2I1z59QNPGvj_oc1ospo8A_wxseTryc";
const SUPABASE_URL = "https://ltgxcrzsgaompsforfna.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_2I1z59QNPGvj_oc1ospo8A_wxseTryc";
const SUPABASE_SDK_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";

let sdkLoadingPromise = null;

function ensureSupabaseSdkLoaded() {
  if (window.supabase && typeof window.supabase.createClient === "function") {
    return Promise.resolve();
  }

  if (sdkLoadingPromise) {
    return sdkLoadingPromise;
  }

  sdkLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-blokus-supabase-sdk='1']");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Supabase SDK 加载失败")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = SUPABASE_SDK_URL;
    script.async = true;
    script.dataset.blokusSupabaseSdk = "1";
    script.onload = () => {
      if (window.supabase && typeof window.supabase.createClient === "function") {
        resolve();
      } else {
        reject(new Error("Supabase SDK 已加载但未找到 createClient"));
      }
    };
    script.onerror = () => reject(new Error("Supabase SDK 脚本下载失败"));
    document.head.appendChild(script);
  });

  return sdkLoadingPromise;
}

async function createSupabaseClient() {
  await ensureSupabaseSdkLoaded();

  if (
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL === "YOUR_SUPABASE_URL" ||
    SUPABASE_ANON_KEY === "YOUR_SUPABASE_ANON_KEY"
  ) {
    throw new Error("请先在 supabase.js 中配置 SUPABASE_URL 和 SUPABASE_ANON_KEY");
  }

  return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
}

async function ensureAnonymousAuth(client) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) {
    throw sessionError;
  }

  if (sessionData?.session?.user) {
    return sessionData.session.user;
  }

  const { data, error } = await client.auth.signInAnonymously();
  if (error) {
    throw error;
  }

  return data.user;
}

function generateRoomId(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += chars[Math.floor(Math.random() * chars.length)];
  }
  return output;
}

async function loadRoom(client, roomId) {
  const { data, error } = await client
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function createRoom(client, payload) {
  const roomId = payload.roomId || generateRoomId();

  const insertPayload = {
    id: roomId,
    status: payload.status || "waiting",
    host_user_id: payload.hostUserId,
    guest_user_id: null,
    current_turn_color: payload.currentTurnColor,
    game_state: payload.gameState,
    winner: payload.winner || null,
  };

  const { data, error } = await client
    .from("rooms")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function joinRoom(client, roomId, userId) {
  const room = await loadRoom(client, roomId);
  if (!room) {
    throw new Error("房间不存在");
  }

  const isHost = room.host_user_id === userId;
  const isGuest = room.guest_user_id === userId;

  if (isHost || isGuest) {
    if (room.status === "waiting" && room.host_user_id && room.guest_user_id) {
      const { data, error } = await client
        .from("rooms")
        .update({ status: "playing" })
        .eq("id", roomId)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      return data;
    }

    return room;
  }

  if (!room.guest_user_id) {
    const patch = {
      guest_user_id: userId,
      status: "playing",
    };

    const { data, error } = await client
      .from("rooms")
      .update(patch)
      .eq("id", roomId)
      .is("guest_user_id", null)
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return data;
  }

  return room;
}

async function updateRoomState(client, roomId, payload, expectedUpdatedAt) {
  let query = client.from("rooms").update(payload).eq("id", roomId);

  if (expectedUpdatedAt) {
    query = query.eq("updated_at", expectedUpdatedAt);
  }

  const { data, error } = await query.select("*").maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("房间状态更新冲突，请重试");
  }

  return data;
}

async function insertMove(client, move) {
  const { error } = await client.from("moves").insert({
    room_id: move.roomId,
    turn_number: move.turnNumber,
    color: move.color,
    piece_id: move.pieceId,
    rotation: move.rotation,
    flipped: move.flipped,
    anchor_row: move.anchorRow,
    anchor_col: move.anchorCol,
    created_by: move.createdBy,
  });

  if (error) {
    throw error;
  }
}

function subscribeToRoom(client, roomId, onChange) {
  const channel = client
    .channel(`room-${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "rooms",
        filter: `id=eq.${roomId}`,
      },
      (payload) => {
        if (!payload?.new) {
          return;
        }
        onChange(payload.new);
      }
    )
    .subscribe();

  return () => {
    client.removeChannel(channel);
  };
}

window.BlokusSupabase = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SDK_URL,
  createSupabaseClient,
  ensureAnonymousAuth,
  createRoom,
  joinRoom,
  loadRoom,
  updateRoomState,
  subscribeToRoom,
  insertMove,
};

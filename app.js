const engine = window.BlokusEngine;
const supabaseApi = window.BlokusSupabase || null;

if (!engine) {
  throw new Error("BlokusEngine 未加载，请先引入 engine.js");
}

const {
  BOARD_SIZE,
  SHAPES,
  SHAPE_ORDER,
  TURN_ORDER,
  COLOR_ORDER,
  COLOR_LABEL,
  createInitialGameState,
  canPlaceMove,
  applyMove,
  calculateScores,
  serializeGameState,
  deserializeGameState,
  getTransformedShape,
} = engine;

const {
  createSupabaseClient: sbCreateSupabaseClient,
  ensureAnonymousAuth: sbEnsureAnonymousAuth,
  createRoom: sbCreateRoom,
  loadRoom: sbLoadRoom,
  updateRoomState: sbUpdateRoomState,
  subscribeToRoom: sbSubscribeToRoom,
  insertMove: sbInsertMove,
} = supabaseApi || {};

const PIECE_LONG_PRESS_MS = 420;
const PIECE_LONG_PRESS_MOVE_CANCEL = 8;
const MAGNIFIER_RADIUS = 3;
const MAGNIFIER_WINDOW_SIZE = MAGNIFIER_RADIUS * 2 + 1;
const MAGNIFIER_MARGIN = 8;
const GAME_MODE_TWO_PLAYER = "2p";
const GAME_MODE_FOUR_PLAYER = "4p";
const ROOM_GAME_STATE_VERSION = 3;
const LOBBY_ACTION_NONE = "none";
const LOBBY_ACTION_CREATE = "create";
const LOBBY_ACTION_JOIN = "join";

const COLOR_OWNER_BY_MODE = {
  [GAME_MODE_TWO_PLAYER]: {
    blue: "player1",
    red: "player2",
    yellow: "player1",
    green: "player2",
  },
  [GAME_MODE_FOUR_PLAYER]: {
    blue: "player1",
    red: "player2",
    yellow: "player3",
    green: "player4",
  },
};

const ROOM_STATUS_LABEL = {
  waiting: "等待开局",
  playing: "对局进行中",
  finished: "对局结束",
};

const CORNER_BY_COLOR = {
  blue: { row: 0, col: 0 },
  yellow: { row: 0, col: BOARD_SIZE - 1 },
  red: { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1 },
  green: { row: BOARD_SIZE - 1, col: 0 },
};

function normalizeGameMode(mode) {
  return mode === 4 || mode === "4" || mode === GAME_MODE_FOUR_PLAYER
    ? GAME_MODE_FOUR_PLAYER
    : GAME_MODE_TWO_PLAYER;
}

function getPlayerSeatsByMode(mode) {
  return normalizeGameMode(mode) === GAME_MODE_FOUR_PLAYER
    ? ["player1", "player2", "player3", "player4"]
    : ["player1", "player2"];
}

function createDefaultColorOwner(mode) {
  const normalizedMode = normalizeGameMode(mode);
  return { ...COLOR_OWNER_BY_MODE[normalizedMode] };
}

function normalizeColorOwner(owner, mode) {
  const defaults = createDefaultColorOwner(mode);
  if (!owner || typeof owner !== "object") {
    return defaults;
  }

  const output = { ...defaults };
  COLOR_ORDER.forEach((color) => {
    const value = owner[color];
    if (typeof value === "string" && /^player[1-4]$/.test(value)) {
      output[color] = value;
    }
  });
  return output;
}

function createEmptyPlayerUserMap(mode) {
  const output = {};
  getPlayerSeatsByMode(mode).forEach((seat) => {
    output[seat] = null;
  });
  return output;
}

function createDefaultPlayerNicknameMap(mode) {
  const output = {};
  getPlayerSeatsByMode(mode).forEach((seat, index) => {
    output[seat] = `玩家${index + 1}`;
  });
  return output;
}

function createDefaultPlayerReadyMap(mode) {
  const output = {};
  getPlayerSeatsByMode(mode).forEach((seat) => {
    output[seat] = false;
  });
  return output;
}

function normalizePlayerUserMap(map, mode) {
  const output = createEmptyPlayerUserMap(mode);
  if (!map || typeof map !== "object") {
    return output;
  }

  Object.keys(output).forEach((seat) => {
    const value = map[seat];
    output[seat] = typeof value === "string" && value ? value : null;
  });
  return output;
}

function normalizePlayerNicknameMap(map, mode) {
  const output = createDefaultPlayerNicknameMap(mode);
  if (!map || typeof map !== "object") {
    return output;
  }

  Object.keys(output).forEach((seat) => {
    const value = map[seat];
    output[seat] = typeof value === "string" && value.trim() ? value.trim() : output[seat];
  });
  return output;
}

function normalizePlayerReadyMap(map, mode) {
  const output = createDefaultPlayerReadyMap(mode);
  if (!map || typeof map !== "object") {
    return output;
  }

  Object.keys(output).forEach((seat) => {
    output[seat] = Boolean(map[seat]);
  });
  return output;
}

function getSeatLabel(seat) {
  if (typeof seat !== "string") {
    return "未加入";
  }
  if (seat === "spectator") {
    return "观战";
  }
  if (seat === "none") {
    return "未加入";
  }
  const match = seat.match(/^player([1-4])$/);
  if (match) {
    return `玩家${match[1]}`;
  }
  return "未加入";
}

function createDefaultRoomConfig(mode) {
  const normalizedMode = normalizeGameMode(mode);
  return {
    mode: normalizedMode,
    colorOwner: createDefaultColorOwner(normalizedMode),
    playerUserMap: createEmptyPlayerUserMap(normalizedMode),
    playerNicknameMap: createDefaultPlayerNicknameMap(normalizedMode),
    playerReadyMap: createDefaultPlayerReadyMap(normalizedMode),
  };
}

const state = {
  view: "lobby",
  game: createInitialGameState(),
  roomConfig: createDefaultRoomConfig(GAME_MODE_TWO_PLAYER),
  lobby: {
    mode: GAME_MODE_TWO_PLAYER,
    nickname: "",
    action: LOBBY_ACTION_NONE,
    status: "请填写昵称，选择模式后创建或加入房间",
  },
  selectedPieceId: null,
  selectedRotation: 0,
  selectedFlipped: false,
  pendingPlacement: null,
  previewAnchor: null,
  preview: null,
  message: "先创建或加入一个房间吧",
  waitingDismissed: false,
  lastScrolledTurnColor: null,
  serializedGameState: "",
  boardPointer: {
    active: false,
    pointerId: null,
  },
  piecePoolGesture: {
    timerId: null,
    pointerId: null,
    pieceId: null,
    startX: 0,
    startY: 0,
    longPressTriggered: false,
    suppressClick: false,
    suppressTimerId: null,
    lastTapPieceId: null,
    lastTapAt: 0,
  },
  miniPreview: {
    pieceId: null,
    rotation: 0,
    flipped: false,
  },
  network: {
    ready: false,
    initializing: false,
    creatingRoom: false,
    syncingMove: false,
    client: null,
    userId: null,
    roomId: null,
    room: null,
    role: "none",
    lastRoomUpdatedAt: null,
    unsubscribeRoom: null,
  },
  layout: {
    gameRefreshScheduled: false,
  },
  dom: {
    lobbyView: null,
    waitingView: null,
    gameView: null,
    lobby: {},
    waiting: {},
    board: null,
    boardArea: null,
    piecePool: null,
    pieceCards: new Map(),
    pieceGrids: new Map(),
    pieceSections: new Map(),
    pieceSectionGrids: new Map(),
    boardCells: new Map(),
    floatingPiece: null,
    floatingPieceGrid: null,
    buttons: {},
    ui: {},
  },
};

function getCellKey(row, col) {
  return `${row}-${col}`;
}

function getCurrentTurnColor() {
  return state.game.currentTurnColor;
}

function canUseColorThisTurn(color) {
  return color === getCurrentTurnColor();
}

function getPlayerByColor(color) {
  const seat = state.roomConfig.colorOwner[color];
  const match = typeof seat === "string" ? seat.match(/^player([1-4])$/) : null;
  return match ? Number(match[1]) : 1;
}

function getPlayerNameByColor(color) {
  const seat = state.roomConfig.colorOwner[color];
  return state.roomConfig.playerNicknameMap?.[seat] || `玩家${getPlayerByColor(color)}`;
}

function getDisplayNameForSeat(seat) {
  if (!seat || !/^player[1-4]$/.test(seat)) {
    return "";
  }
  return state.roomConfig.playerNicknameMap?.[seat] || getDefaultNicknameBySeat(seat);
}

function getPieceById(pieceId) {
  return state.game.pieces.find((piece) => piece.pieceId === pieceId) || null;
}

function normalizePoints(points) {
  if (!points.length) {
    return [];
  }

  let minX = Infinity;
  let minY = Infinity;

  points.forEach(([x, y]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  });

  return points.map(([x, y]) => [x - minX, y - minY]);
}

function getRoomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("room");
  if (!value) {
    return "";
  }
  return value.trim();
}

function setRoomIdToUrl(roomId) {
  const url = new URL(window.location.href);
  if (!roomId) {
    url.searchParams.delete("room");
  } else {
    url.searchParams.set("room", roomId);
  }
  window.history.replaceState({}, "", url.toString());
}

function getRoomLink(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

function normalizeRoomCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function getDefaultNicknameBySeat(seat) {
  const match = typeof seat === "string" ? seat.match(/^player([1-4])$/) : null;
  const index = match ? Number(match[1]) : 1;
  return `玩家${index}`;
}

function getLobbyNicknameInputValue() {
  const fromState = String(state.lobby.nickname || "").trim();
  if (fromState) {
    return fromState;
  }
  if (state.dom.lobby.nicknameInput) {
    const fromInput = String(state.dom.lobby.nicknameInput.value || "").trim();
    if (fromInput) {
      return fromInput;
    }
  }
  return "";
}

function serializeRoomGameState(gameState, roomConfig) {
  const safeConfig = roomConfig || createDefaultRoomConfig(GAME_MODE_TWO_PLAYER);
  return JSON.stringify({
    version: ROOM_GAME_STATE_VERSION,
    mode: normalizeGameMode(safeConfig.mode) === GAME_MODE_FOUR_PLAYER ? 4 : 2,
    colorOwner: normalizeColorOwner(safeConfig.colorOwner, safeConfig.mode),
    playerUserMap: normalizePlayerUserMap(safeConfig.playerUserMap, safeConfig.mode),
    playerNicknameMap: normalizePlayerNicknameMap(safeConfig.playerNicknameMap, safeConfig.mode),
    playerReadyMap: normalizePlayerReadyMap(safeConfig.playerReadyMap, safeConfig.mode),
    engineState: serializeGameState(gameState),
  });
}

function parseRoomGameState(rawGameState, room) {
  const legacyConfig = createDefaultRoomConfig(GAME_MODE_TWO_PLAYER);
  legacyConfig.playerUserMap.player1 = room?.host_user_id || null;
  legacyConfig.playerUserMap.player2 = room?.guest_user_id || null;

  const fallback = {
    game: createInitialGameState(),
    config: legacyConfig,
  };

  if (rawGameState === null || rawGameState === undefined || rawGameState === "") {
    return fallback;
  }

  let parsed = rawGameState;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (_error) {
      try {
        return {
          game: deserializeGameState(rawGameState),
          config: legacyConfig,
        };
      } catch (_error2) {
        return fallback;
      }
    }
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "engineState")
  ) {
    const mode = normalizeGameMode(parsed.mode);
    const config = {
      mode,
      colorOwner: normalizeColorOwner(parsed.colorOwner, mode),
      playerUserMap: normalizePlayerUserMap(parsed.playerUserMap, mode),
      playerNicknameMap: normalizePlayerNicknameMap(parsed.playerNicknameMap, mode),
      playerReadyMap: normalizePlayerReadyMap(parsed.playerReadyMap, mode),
    };

    try {
      return {
        game: deserializeGameState(parsed.engineState),
        config,
      };
    } catch (_error) {
      return {
        game: createInitialGameState(),
        config,
      };
    }
  }

  try {
    return {
      game: deserializeGameState(parsed),
      config: legacyConfig,
    };
  } catch (_error) {
    return fallback;
  }
}

function getRoleByRoom(room, userId) {
  if (!room || !userId) {
    return "none";
  }

  const parsed = parseRoomGameState(room.game_state, room);
  const seats = getPlayerSeatsByMode(parsed.config.mode);
  for (const seat of seats) {
    if (parsed.config.playerUserMap[seat] === userId) {
      return seat;
    }
  }
  return "spectator";
}

function getRoleByRoomConfig(config, userId) {
  if (!userId) {
    return "none";
  }
  const seats = getPlayerSeatsByMode(config.mode);
  for (const seat of seats) {
    if (config.playerUserMap[seat] === userId) {
      return seat;
    }
  }
  return "spectator";
}

function getJoinedSeatCount(config) {
  return getPlayerSeatsByMode(config.mode).filter((seat) => Boolean(config.playerUserMap[seat])).length;
}

function getExpectedRoomStatusByConfig(game, config, previousStatus) {
  if (game.gameOver) {
    return "finished";
  }

  if (previousStatus === "playing" || previousStatus === "finished") {
    return previousStatus;
  }

  return "waiting";
}

function canClientUseColor(color) {
  const role = state.network.role;
  if (!/^player[1-4]$/.test(role)) {
    return false;
  }
  return state.roomConfig.colorOwner[color] === role;
}

function getEffectiveRoomStatus() {
  const status = state.network.room?.status;
  if (status === "finished") {
    return "finished";
  }

  if (state.game.gameOver) {
    return "finished";
  }

  return status || "waiting";
}

function getWaitingSeats() {
  const seats = getPlayerSeatsByMode(state.roomConfig.mode);
  return seats.filter((seat) => !state.roomConfig.playerUserMap[seat]);
}

function getJoinedSeats(config = state.roomConfig) {
  return getPlayerSeatsByMode(config.mode).filter((seat) => Boolean(config.playerUserMap[seat]));
}

function areAllJoinedPlayersReady(config = state.roomConfig) {
  const seats = getPlayerSeatsByMode(config.mode);
  const joinedSeats = seats.filter((seat) => Boolean(config.playerUserMap[seat]));
  if (joinedSeats.length !== seats.length || joinedSeats.length === 0) {
    return false;
  }
  return joinedSeats.every((seat) => Boolean(config.playerReadyMap?.[seat]));
}

function getHostSeat(config = state.roomConfig, room = state.network.room) {
  if (!room?.host_user_id) {
    return "";
  }
  return getPlayerSeatsByMode(config.mode).find((seat) => config.playerUserMap?.[seat] === room.host_user_id) || "";
}

function isCurrentUserHost() {
  return Boolean(state.network.room?.host_user_id) && state.network.room.host_user_id === state.network.userId;
}

function canHostStartGame() {
  const room = state.network.room;
  if (!room || room.status !== "waiting") {
    return false;
  }
  return isCurrentUserHost() && areAllJoinedPlayersReady(state.roomConfig);
}

function getCannotOperateReason() {
  if (!state.network.ready) {
    return "正在连接联机服务，请稍等";
  }

  if (!state.network.roomId || !state.network.room) {
    return "先创建或加入一个房间吧";
  }

  if (state.network.role === "spectator") {
    return "你正在观战，暂时不能落子";
  }

  const roomStatus = getEffectiveRoomStatus();
  if (roomStatus === "waiting") {
    return "等待其他玩家就位";
  }

  if (roomStatus === "finished" || state.game.gameOver) {
    return "这局已经结束了";
  }

  if (!canClientUseColor(getCurrentTurnColor())) {
    return `现在是${COLOR_LABEL[getCurrentTurnColor()]}色回合，先等对手行动`;
  }

  return "";
}

function canCurrentClientOperate() {
  return getCannotOperateReason() === "";
}

function setView(view) {
  if (view === "game" || view === "waiting") {
    state.view = view;
    return;
  }
  state.view = "lobby";
}

function setLobbyAction(action) {
  if (action !== LOBBY_ACTION_CREATE && action !== LOBBY_ACTION_JOIN) {
    state.lobby.action = LOBBY_ACTION_NONE;
    return;
  }
  state.lobby.action = state.lobby.action === action ? LOBBY_ACTION_NONE : action;
}

function setLobbyMode(mode) {
  state.lobby.mode = normalizeGameMode(mode);
}

function updateLobbyStatus(message) {
  if (typeof message === "string" && message) {
    state.lobby.status = message;
  }
}

function renderLobby() {
  const lobbyView = state.dom.lobbyView;
  if (!lobbyView) {
    return;
  }

  lobbyView.hidden = state.view !== "lobby";

  const lobby = state.dom.lobby;
  if (!lobby.mode2Btn) {
    return;
  }

  lobby.mode2Btn.classList.toggle("is-active", state.lobby.mode === GAME_MODE_TWO_PLAYER);
  lobby.mode4Btn.classList.toggle("is-active", state.lobby.mode === GAME_MODE_FOUR_PLAYER);

  const isCreateOpen = state.lobby.action === LOBBY_ACTION_CREATE;
  const isJoinOpen = state.lobby.action === LOBBY_ACTION_JOIN;

  lobby.createPanel.classList.toggle("is-open", isCreateOpen);
  lobby.joinPanel.classList.toggle("is-open", isJoinOpen);
  lobby.createPanel.setAttribute("aria-hidden", isCreateOpen ? "false" : "true");
  lobby.joinPanel.setAttribute("aria-hidden", isJoinOpen ? "false" : "true");
  lobby.createToggleBtn.classList.toggle("is-open", isCreateOpen);
  lobby.joinToggleBtn.classList.toggle("is-open", isJoinOpen);

  lobby.createToggleBtn.textContent = isCreateOpen ? "取消创建" : "创建房间";
  lobby.joinToggleBtn.textContent = isJoinOpen ? "取消加入" : "加入房间";

  if (lobby.nicknameInput && lobby.nicknameInput.value !== state.lobby.nickname) {
    lobby.nicknameInput.value = state.lobby.nickname;
  }

  if (lobby.statusText) {
    lobby.statusText.textContent = state.lobby.status;
  }

  if (lobby.returnRoomBtn) {
    const canReturnRoom = Boolean(state.network.roomId) && Boolean(state.network.room);
    lobby.returnRoomBtn.hidden = !canReturnRoom;
  }
}

function renderWaiting() {
  const waitingView = state.dom.waitingView;
  if (!waitingView) {
    return;
  }

  const inWaiting = state.view === "waiting";
  waitingView.hidden = !inWaiting;

  const waiting = state.dom.waiting;
  if (!waiting.roomCodeText) {
    return;
  }

  const room = state.network.room;
  const config = state.roomConfig;
  const seats = getPlayerSeatsByMode(config.mode);
  const joinedSeats = getJoinedSeats(config);
  const joinedCount = joinedSeats.length;
  const totalCount = seats.length;

  waiting.roomCodeText.textContent = room?.id || "--";
  waiting.playerCountText.textContent = `等待玩家（${joinedCount}/${totalCount}）`;

  const hostSeat = getHostSeat(config, room);
  waiting.playersList.innerHTML = "";
  seats.forEach((seat) => {
    const row = document.createElement("div");
    row.className = "waiting-player-row";

    const name = document.createElement("span");
    name.className = "waiting-player-name";
    const joined = Boolean(config.playerUserMap?.[seat]);
    const nickname = getDisplayNameForSeat(seat);
    if (joined) {
      name.textContent = seat === hostSeat ? `${nickname}（房主）` : nickname;
    } else {
      name.textContent = getDefaultNicknameBySeat(seat);
    }

    const badge = document.createElement("span");
    badge.className = "waiting-status-badge";
    if (!joined) {
      badge.classList.add("status-empty");
      badge.textContent = "待加入";
    } else if (config.playerReadyMap?.[seat]) {
      badge.classList.add("status-ready");
      badge.textContent = "已准备";
    } else {
      badge.classList.add("status-pending");
      badge.textContent = "未准备";
    }

    row.appendChild(name);
    row.appendChild(badge);
    waiting.playersList.appendChild(row);
  });

  const isPlayerSeat = /^player[1-4]$/.test(state.network.role);
  const roomStatus = room?.status || "waiting";
  const canToggleReady = inWaiting && isPlayerSeat && roomStatus === "waiting";
  const selfReady = isPlayerSeat ? Boolean(config.playerReadyMap?.[state.network.role]) : false;
  waiting.readyBtn.disabled = !canToggleReady;
  waiting.readyBtn.textContent = selfReady ? "取消准备" : "准备";
  waiting.readyBtn.classList.toggle("is-ready", selfReady);

  const canStart = canHostStartGame();
  waiting.startBtn.disabled = !canStart;
  waiting.startBtn.textContent = isCurrentUserHost() ? "开始游戏" : "等待房主开始";

  if (!room) {
    waiting.hintText.textContent = "正在连接房间...";
  } else if (roomStatus === "playing") {
    waiting.hintText.textContent = "对局已开始，正在进入棋盘";
  } else if (canStart) {
    waiting.hintText.textContent = "所有玩家已准备，房主可以开始";
  } else if (areAllJoinedPlayersReady(config)) {
    waiting.hintText.textContent = "已全部准备，等待房主开始";
  } else {
    waiting.hintText.textContent = "准备好后点击“准备”，等待全员就绪";
  }
}

function syncSerializedState() {
  state.serializedGameState = serializeGameState(state.game);
}

function clearPiecePoolGestureState() {
  if (state.piecePoolGesture.timerId !== null) {
    clearTimeout(state.piecePoolGesture.timerId);
  }

  state.piecePoolGesture.timerId = null;
  state.piecePoolGesture.pointerId = null;
  state.piecePoolGesture.pieceId = null;
  state.piecePoolGesture.startX = 0;
  state.piecePoolGesture.startY = 0;
  state.piecePoolGesture.longPressTriggered = false;
}

function clearRoomSubscription() {
  if (typeof state.network.unsubscribeRoom === "function") {
    state.network.unsubscribeRoom();
  }
  state.network.unsubscribeRoom = null;
}

function clearTransientSelection() {
  clearPiecePoolGestureState();

  if (state.piecePoolGesture.suppressTimerId !== null) {
    clearTimeout(state.piecePoolGesture.suppressTimerId);
    state.piecePoolGesture.suppressTimerId = null;
  }

  state.piecePoolGesture.suppressClick = false;
  state.piecePoolGesture.lastTapPieceId = null;
  state.piecePoolGesture.lastTapAt = 0;

  if (state.boardPointer.pointerId !== null && state.dom.board?.releasePointerCapture) {
    try {
      state.dom.board.releasePointerCapture(state.boardPointer.pointerId);
    } catch (_error) {
      // Ignore release failures when pointer was not captured.
    }
  }

  state.selectedPieceId = null;
  state.selectedRotation = 0;
  state.selectedFlipped = false;
  state.pendingPlacement = null;
  state.previewAnchor = null;
  state.preview = null;
  state.boardPointer.active = false;
  state.boardPointer.pointerId = null;
}

function clearSelection(message) {
  clearTransientSelection();

  if (typeof message === "string") {
    state.message = message;
  }

  render();
}

function createBoard() {
  const board = state.dom.board;
  if (!board) {
    return;
  }

  board.innerHTML = "";
  state.dom.boardCells.clear();

  const fragment = document.createDocumentFragment();

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = document.createElement("div");
      cell.className = "board-cell";
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      fragment.appendChild(cell);
      state.dom.boardCells.set(getCellKey(row, col), cell);
    }
  }

  board.appendChild(fragment);
}

function drawMiniShapeFromPoints(grid, points, color) {
  grid.innerHTML = "";

  const normalizedPoints = normalizePoints(points.map(([x, y]) => [x, y]));
  let maxX = 0;
  let maxY = 0;

  normalizedPoints.forEach(([x, y]) => {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });

  const width = maxX + 1;
  const height = maxY + 1;
  const totalCells = width * height;

  grid.style.gridTemplateColumns = `repeat(${width}, var(--piece-cell-size))`;
  grid.style.gridTemplateRows = `repeat(${height}, var(--piece-cell-size))`;

  for (let i = 0; i < totalCells; i += 1) {
    const miniCell = document.createElement("i");
    miniCell.className = "mini-cell";
    grid.appendChild(miniCell);
  }

  normalizedPoints.forEach(([x, y]) => {
    const index = y * width + x;
    const target = grid.children[index];
    if (!target) {
      return;
    }
    target.classList.add("filled", `color-${color}`);
  });
}

function drawMiniShape(grid, shapeName, color) {
  drawMiniShapeFromPoints(grid, SHAPES[shapeName] || [], color);
}

function createPiecePool() {
  const pool = state.dom.piecePool;
  if (!pool) {
    return;
  }

  pool.innerHTML = "";
  state.dom.pieceCards.clear();
  state.dom.pieceGrids.clear();
  state.dom.pieceSections.clear();
  state.dom.pieceSectionGrids.clear();

  const fragment = document.createDocumentFragment();

  TURN_ORDER.forEach((color) => {
    const section = document.createElement("section");
    section.className = "piece-color-section";
    section.dataset.color = color;

    const title = document.createElement("h3");
    title.className = "piece-color-title";
    title.dataset.color = color;
    title.textContent = COLOR_LABEL[color];

    const grid = document.createElement("div");
    grid.className = "piece-color-grid";
    grid.dataset.color = color;

    section.appendChild(title);
    section.appendChild(grid);
    state.dom.pieceSections.set(color, section);
    state.dom.pieceSectionGrids.set(color, grid);
    fragment.appendChild(section);
  });

  const shapeOrderMap = new Map(SHAPE_ORDER.map((shapeName, index) => [shapeName, index]));

  TURN_ORDER.forEach((color) => {
    const sectionGrid = state.dom.pieceSectionGrids.get(color);
    if (!sectionGrid) {
      return;
    }

    const piecesBySize = state.game.pieces
      .filter((piece) => piece.color === color)
      .sort((a, b) => {
        const sizeDiff = (SHAPES[a.shape]?.length || 0) - (SHAPES[b.shape]?.length || 0);
        if (sizeDiff !== 0) {
          return sizeDiff;
        }
        return (shapeOrderMap.get(a.shape) || 0) - (shapeOrderMap.get(b.shape) || 0);
      });

    piecesBySize.forEach((piece) => {
      const card = document.createElement("article");
      card.className = "piece-card";
      card.dataset.pieceId = piece.pieceId;
      card.dataset.shape = piece.shape;
      card.dataset.color = piece.color;

      const miniGrid = document.createElement("div");
      miniGrid.className = "piece-grid";
      miniGrid.setAttribute("aria-hidden", "true");
      drawMiniShape(miniGrid, piece.shape, piece.color);

      card.appendChild(miniGrid);

      state.dom.pieceCards.set(piece.pieceId, card);
      state.dom.pieceGrids.set(piece.pieceId, miniGrid);
      sectionGrid.appendChild(card);
    });
  });

  pool.appendChild(fragment);
}

function syncSelectedPieceMiniPreview() {
  const previous = state.miniPreview;
  const currentPieceId = state.selectedPieceId;

  if (previous.pieceId && previous.pieceId !== currentPieceId) {
    const previousPiece = getPieceById(previous.pieceId);
    const previousGrid = state.dom.pieceGrids.get(previous.pieceId);
    if (previousPiece && previousGrid) {
      drawMiniShape(previousGrid, previousPiece.shape, previousPiece.color);
    }
  }

  if (!currentPieceId) {
    state.miniPreview = {
      pieceId: null,
      rotation: 0,
      flipped: false,
    };
    return;
  }

  if (
    previous.pieceId === currentPieceId &&
    previous.rotation === state.selectedRotation &&
    previous.flipped === state.selectedFlipped
  ) {
    return;
  }

  const selectedPiece = getPieceById(currentPieceId);
  const selectedGrid = state.dom.pieceGrids.get(currentPieceId);
  if (!selectedPiece || !selectedGrid) {
    return;
  }

  const transformed = getTransformedShape(
    selectedPiece.shape,
    state.selectedRotation,
    state.selectedFlipped
  );
  drawMiniShapeFromPoints(selectedGrid, transformed, selectedPiece.color);

  state.miniPreview = {
    pieceId: currentPieceId,
    rotation: state.selectedRotation,
    flipped: state.selectedFlipped,
  };
}

function renderPiecePool() {
  const currentTurnColor = getCurrentTurnColor();

  TURN_ORDER.forEach((color) => {
    const section = state.dom.pieceSections.get(color);
    if (!section) {
      return;
    }

    const isActive = color === currentTurnColor;
    section.classList.toggle("is-active", isActive);
    section.classList.toggle("is-inactive", !isActive);
    section.classList.toggle("is-hidden", !isActive);
  });

  if (state.dom.ui.piecePoolHint) {
    state.dom.ui.piecePoolHint.textContent = `现在是${COLOR_LABEL[currentTurnColor]}色回合`;
  }

  state.game.pieces.forEach((piece) => {
    const card = state.dom.pieceCards.get(piece.pieceId);
    if (!card) {
      return;
    }

    const isPendingUsed = Boolean(
      state.pendingPlacement && state.pendingPlacement.move?.pieceId === piece.pieceId
    );
    const isUsed = piece.used || isPendingUsed;
    const isSelected = state.selectedPieceId === piece.pieceId;
    const canSelectThisPiece =
      !isUsed &&
      !state.pendingPlacement &&
      canCurrentClientOperate() &&
      canClientUseColor(piece.color) &&
      canUseColorThisTurn(piece.color);

    const isTurnLocked = !isUsed && !canSelectThisPiece;

    card.classList.toggle("is-selected", isSelected);
    card.classList.toggle("is-used", isUsed);
    card.classList.toggle("is-turn-locked", isTurnLocked);
    card.setAttribute("aria-disabled", isUsed || isTurnLocked ? "true" : "false");
  });

  syncSelectedPieceMiniPreview();
}

function scrollToCurrentColorSection(behavior = "smooth") {
  const section = state.dom.pieceSections.get(getCurrentTurnColor());
  if (!section) {
    return;
  }

  section.scrollIntoView({
    behavior,
    block: "nearest",
    inline: "nearest",
  });
}

function maybeAutoScrollCurrentTurnSection() {
  const turnColor = getCurrentTurnColor();
  if (state.lastScrolledTurnColor === turnColor) {
    return;
  }

  const behavior = state.lastScrolledTurnColor === null ? "auto" : "smooth";
  scrollToCurrentColorSection(behavior);
  state.lastScrolledTurnColor = turnColor;
}

function getCornerColorAt(row, col) {
  for (const [color, corner] of Object.entries(CORNER_BY_COLOR)) {
    if (corner.row === row && corner.col === col) {
      return color;
    }
  }
  return "";
}

function renderFloatingPreview() {
  const floating = state.dom.floatingPiece;
  const floatingGrid = state.dom.floatingPieceGrid;
  const boardArea = state.dom.boardArea;

  if (!floating || !floatingGrid || !boardArea) {
    return;
  }

  const shouldShow =
    Boolean(state.selectedPieceId) &&
    state.boardPointer.active &&
    Boolean(state.previewAnchor) &&
    Boolean(state.preview) &&
    !state.game.gameOver;

  if (!shouldShow) {
    floating.classList.remove("is-visible");
    floatingGrid.innerHTML = "";
    floating.style.left = "";
    floating.style.top = "";
    return;
  }

  const centerRow = state.preview.anchorRow;
  const centerCol = state.preview.anchorCol;
  const previewCellSet = new Set((state.preview.cells || []).map((cell) => getCellKey(cell.row, cell.col)));

  floatingGrid.innerHTML = "";
  floatingGrid.style.gridTemplateColumns = `repeat(${MAGNIFIER_WINDOW_SIZE}, var(--magnifier-cell-size))`;
  floatingGrid.style.gridTemplateRows = `repeat(${MAGNIFIER_WINDOW_SIZE}, var(--magnifier-cell-size))`;

  for (let row = centerRow - MAGNIFIER_RADIUS; row <= centerRow + MAGNIFIER_RADIUS; row += 1) {
    for (let col = centerCol - MAGNIFIER_RADIUS; col <= centerCol + MAGNIFIER_RADIUS; col += 1) {
      const miniCell = document.createElement("i");
      miniCell.className = "magnifier-cell";

      if (!isInBounds(row, col)) {
        miniCell.classList.add("is-out");
        floatingGrid.appendChild(miniCell);
        continue;
      }

      const occupied = state.game.boardMatrix[row][col];
      if (occupied) {
        miniCell.classList.add(`placed-${occupied.color}`);
      }

      if (previewCellSet.has(getCellKey(row, col))) {
        miniCell.classList.add("preview");
        if (state.preview.valid) {
          miniCell.classList.add(`preview-${state.preview.color}`);
        } else {
          miniCell.classList.add("preview-invalid");
        }
      }

      if (row === centerRow && col === centerCol) {
        miniCell.classList.add("preview-anchor");
      }

      const cornerColor = getCornerColorAt(row, col);
      if (cornerColor) {
        miniCell.classList.add(`start-corner-${cornerColor}`);
        const firstDone = Boolean(state.game.firstMoveDoneByColor?.[cornerColor]);
        miniCell.classList.add(firstDone ? "start-corner-done" : "start-corner-active");
      }

      floatingGrid.appendChild(miniCell);
    }
  }

  const boardAreaRect = boardArea.getBoundingClientRect();
  const floatW = floating.offsetWidth || 190;
  const floatH = floating.offsetHeight || 190;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  let left = Math.round(boardAreaRect.left + (boardAreaRect.width - floatW) / 2);
  let top = Math.round(boardAreaRect.top - floatH - MAGNIFIER_MARGIN);

  if (top < MAGNIFIER_MARGIN) {
    top = Math.round(boardAreaRect.top + MAGNIFIER_MARGIN);
  }

  left = Math.max(MAGNIFIER_MARGIN, Math.min(left, viewportW - floatW - MAGNIFIER_MARGIN));
  top = Math.max(MAGNIFIER_MARGIN, Math.min(top, viewportH - floatH - MAGNIFIER_MARGIN));

  floating.style.left = `${left}px`;
  floating.style.top = `${top}px`;
  floating.classList.add("is-visible");
}

function isInBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function getTransformedPointsByPiece(piece) {
  if (!piece) {
    return [];
  }

  return getTransformedShape(piece.shape, state.selectedRotation, state.selectedFlipped);
}

function getShapeBounds(points) {
  if (!points.length) {
    return {
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  points.forEach(([x, y]) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });

  return {
    minX,
    maxX,
    minY,
    maxY,
  };
}

function getClampedAnchorForSelectedPiece(rawRow, rawCol) {
  const piece = getPieceById(state.selectedPieceId);
  if (!piece) {
    return { row: rawRow, col: rawCol };
  }

  const points = getTransformedPointsByPiece(piece);
  const bounds = getShapeBounds(points);

  const minAllowedCol = -bounds.minX;
  const maxAllowedCol = BOARD_SIZE - 1 - bounds.maxX;
  const minAllowedRow = -bounds.minY;
  const maxAllowedRow = BOARD_SIZE - 1 - bounds.maxY;

  return {
    row: clamp(rawRow, minAllowedRow, maxAllowedRow),
    col: clamp(rawCol, minAllowedCol, maxAllowedCol),
  };
}

function buildMove(anchorRow, anchorCol) {
  if (!state.selectedPieceId) {
    return null;
  }

  return {
    pieceId: state.selectedPieceId,
    anchorRow,
    anchorCol,
    rotation: state.selectedRotation,
    flipped: state.selectedFlipped,
  };
}

function buildPreview(move) {
  if (!move) {
    return null;
  }

  const piece = getPieceById(move.pieceId);
  if (!piece) {
    return null;
  }

  const check = canPlaceMove(state.game, move);

  return {
    anchorRow: move.anchorRow,
    anchorCol: move.anchorCol,
    move,
    color: piece.color,
    cells: check.cells || [],
    valid: check.valid,
    reason: check.reason,
  };
}

function renderPreview() {
  if (!state.preview) {
    return;
  }

  state.preview.cells.forEach((cell) => {
    if (!isInBounds(cell.row, cell.col)) {
      return;
    }

    const target = state.dom.boardCells.get(getCellKey(cell.row, cell.col));
    if (!target) {
      return;
    }

    target.classList.add("preview");
    if (state.preview.valid) {
      target.classList.add(`preview-${state.preview.color}`);
    } else {
      target.classList.add("preview-invalid");
    }
  });

  if (isInBounds(state.preview.anchorRow, state.preview.anchorCol)) {
    const anchorCell = state.dom.boardCells.get(getCellKey(state.preview.anchorRow, state.preview.anchorCol));
    if (anchorCell) {
      anchorCell.classList.add("preview-anchor");
    }
  }
}

function renderBoard() {
  const pendingCellSet = new Set(
    (state.pendingPlacement?.cells || []).map((cell) => getCellKey(cell.row, cell.col))
  );
  const pendingColor = state.pendingPlacement?.color || "";

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const cell = state.dom.boardCells.get(getCellKey(row, col));
      if (!cell) {
        continue;
      }

      cell.className = "board-cell";
      const occupied = state.game.boardMatrix[row][col];
      if (occupied) {
        cell.classList.add(`placed-${occupied.color}`);
      } else if (pendingCellSet.has(getCellKey(row, col)) && pendingColor) {
        cell.classList.add(`placed-${pendingColor}`, "placed-pending");
      }
    }
  }

  Object.entries(CORNER_BY_COLOR).forEach(([color, corner]) => {
    const cornerCell = state.dom.boardCells.get(getCellKey(corner.row, corner.col));
    if (!cornerCell) {
      return;
    }

    cornerCell.classList.add(`start-corner-${color}`);
    const firstDone = Boolean(state.game.firstMoveDoneByColor?.[color]);
    cornerCell.classList.add(firstDone ? "start-corner-done" : "start-corner-active");
  });

  renderPreview();
}

function getResultText(scores) {
  const seats = getPlayerSeatsByMode(state.roomConfig.mode);
  const seatScores = seats.map((seat) => {
    const total = COLOR_ORDER.reduce((sum, color) => {
      if (state.roomConfig.colorOwner[color] !== seat) {
        return sum;
      }
      return sum + (scores.placedCellsByColor[color] || 0);
    }, 0);
    return {
      seat,
      name: getDisplayNameForSeat(seat) || getDefaultNicknameBySeat(seat),
      total,
    };
  });

  const sorted = [...seatScores].sort((a, b) => b.total - a.total);
  const top = sorted[0];
  const tied = sorted.filter((item) => item.total === top.total);

  if (state.game.gameOver) {
    if (tied.length > 1) {
      return "对局结束，平局";
    }
    return `对局结束，${top.name}获胜`;
  }

  if (tied.length > 1) {
    return "对局进行中，比分接近";
  }
  return `对局进行中，${top.name}领先`;
}

function updateRoomCardUI() {
  const room = state.network.room;
  const roomId = state.network.roomId;
  const roomStatus = getEffectiveRoomStatus();
  const canAct = canCurrentClientOperate();

  if (!roomId || !room) {
    if (state.dom.ui.roomCode) {
      state.dom.ui.roomCode.textContent = "房间 --";
    }
    if (state.dom.ui.roomStatus) {
      state.dom.ui.roomStatus.textContent = "先创建或加入房间";
    }
    if (state.dom.ui.roomCanAct) {
      state.dom.ui.roomCanAct.textContent = "进入房间后可开始对局";
    }
    if (state.dom.ui.roomHint) {
      state.dom.ui.roomHint.textContent = !state.network.ready
        ? "联机服务连接中，稍后会自动恢复"
        : "进入房间后可以复制邀请链接";
    }
    state.dom.buttons.copyRoomLink.disabled = true;
    return;
  }

  const turnColor = getCurrentTurnColor();
  if (state.dom.ui.roomCode) {
    state.dom.ui.roomCode.textContent = `房间 ${room.id}`;
  }
  if (state.dom.ui.roomStatus) {
    state.dom.ui.roomStatus.textContent = `轮到${getPlayerNameByColor(turnColor)}（${COLOR_LABEL[turnColor]}色）`;
  }
  if (state.dom.ui.roomCanAct) {
    state.dom.ui.roomCanAct.textContent = canAct ? "轮到你行动" : `等待${getPlayerNameByColor(turnColor)}落子`;
  }

  if (roomStatus === "waiting") {
    const waitingSeats = getWaitingSeats();
    if (waitingSeats.length > 0) {
      if (state.dom.ui.roomHint) {
        state.dom.ui.roomHint.textContent = `等待${waitingSeats
          .map((seat) => getDisplayNameForSeat(seat) || getSeatLabel(seat))
          .join("、")}入座`;
      }
    } else {
      if (state.dom.ui.roomHint) {
        state.dom.ui.roomHint.textContent = "玩家已就位，马上开始";
      }
    }
  } else if (roomStatus === "playing") {
    if (state.dom.ui.roomHint) {
      state.dom.ui.roomHint.textContent = canAct ? "请选择一个拼块开始落子" : "等待对手落子";
    }
  } else {
    if (state.dom.ui.roomHint) {
      state.dom.ui.roomHint.textContent = "这局已经结束，可复制链接回看结果";
    }
  }

  state.dom.buttons.copyRoomLink.disabled = false;
}

function updateTurnUI() {
  const turnColor = getCurrentTurnColor();
  const turnPlayerName = getPlayerNameByColor(turnColor);
  const scores = state.game.scores || calculateScores(state.game);

  state.dom.ui.turnPlayer.textContent = `轮到 ${turnPlayerName}`;
  state.dom.ui.turnNumber.textContent = `第 ${state.game.turnCount} 手`;
  state.dom.ui.turnColors.textContent = `当前颜色：${COLOR_LABEL[turnColor]}`;
  if (state.dom.ui.turnMode) {
    state.dom.ui.turnMode.textContent = state.roomConfig.mode === GAME_MODE_FOUR_PLAYER ? "4人模式" : "2人模式";
  }

  if (state.dom.ui.statusText) {
    state.dom.ui.statusText.textContent = state.message;
  }

  COLOR_ORDER.forEach((color) => {
    const key = `${color[0].toUpperCase()}${color.slice(1)}`;

    const remainEl = state.dom.ui[`remain${key}`];
    if (remainEl) {
      remainEl.textContent = String(scores.remainingPiecesByColor[color]);
    }

    const placedEl = state.dom.ui[`placed${key}`];
    if (placedEl) {
      placedEl.textContent = String(scores.placedCellsByColor[color]);
    }

    const remainCellsEl = state.dom.ui[`cellsRemain${key}`];
    if (remainCellsEl) {
      remainCellsEl.textContent = String(scores.remainingCellsByColor[color]);
    }
  });

  if (state.dom.ui.scoreList) {
    state.dom.ui.scoreList.innerHTML = "";
    const seats = getPlayerSeatsByMode(state.roomConfig.mode);
    seats.forEach((seat) => {
      const name = getDisplayNameForSeat(seat) || getDefaultNicknameBySeat(seat);
      const total = COLOR_ORDER.reduce((sum, color) => {
        if (state.roomConfig.colorOwner[color] !== seat) {
          return sum;
        }
        return sum + (scores.placedCellsByColor[color] || 0);
      }, 0);

      const line = document.createElement("p");
      line.className = "score-line";
      line.textContent = `${name}：${total}分`;
      state.dom.ui.scoreList.appendChild(line);
    });
  }

  state.dom.ui.resultText.textContent = getResultText(scores);
  state.dom.ui.resultCard.classList.toggle("is-finished", state.game.gameOver);

  updateRoomCardUI();
}

function renderControls() {
  const hasPending = Boolean(state.pendingPlacement);
  const hasSelected = Boolean(state.selectedPieceId);
  const canOperate = hasSelected && canCurrentClientOperate() && !state.network.syncingMove && !hasPending;
  const canPlace = canOperate && Boolean(state.preview?.valid);

  state.dom.buttons.rotate.disabled = !canOperate;
  state.dom.buttons.flip.disabled = !canOperate;

  if (hasPending) {
    state.dom.buttons.place.textContent = "下一回合";
    state.dom.buttons.place.disabled = !canCurrentClientOperate() || state.network.syncingMove;
    state.dom.buttons.place.classList.add("is-ready");
  } else {
    state.dom.buttons.place.textContent = "放置";
    state.dom.buttons.place.disabled = !canPlace;
    state.dom.buttons.place.classList.toggle("is-ready", canPlace);
  }

  state.dom.buttons.cancel.textContent = "重选";
  state.dom.buttons.cancel.disabled = state.game.gameOver || (!hasPending && !hasSelected && !state.preview);
}

function render() {
  const gameJustShown = Boolean(state.dom.gameView && state.view === "game" && state.dom.gameView.hidden);

  renderLobby();
  renderWaiting();
  if (state.dom.gameView) {
    state.dom.gameView.hidden = state.view !== "game";
  }

  if (state.view !== "game") {
    return;
  }

  if (gameJustShown) {
    updateLayout();
    scheduleGameLayoutRefresh();
  }

  renderPiecePool();
  maybeAutoScrollCurrentTurnSection();
  renderBoard();
  renderFloatingPreview();
  updateTurnUI();
  renderControls();
  syncSerializedState();
}

function selectPiece(pieceId) {
  if (state.game.gameOver) {
    state.message = "这局已经结束了";
    render();
    return;
  }

  if (state.pendingPlacement) {
    state.message = "这一步已落子，点击“下一回合”继续";
    render();
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  const piece = getPieceById(pieceId);
  if (!piece) {
    return;
  }

  if (piece.used) {
    state.message = "这个拼块已经用过了";
    render();
    return;
  }

  if (!canUseColorThisTurn(piece.color)) {
    state.message = `现在是${COLOR_LABEL[getCurrentTurnColor()]}色回合`;
    render();
    return;
  }

  if (!canClientUseColor(piece.color)) {
    state.message = "该颜色不属于你的可操作范围";
    render();
    return;
  }

  if (state.selectedPieceId === piece.pieceId) {
    state.message = `已选中${COLOR_LABEL[piece.color]}色拼块`;
    render();
    return;
  }

  state.selectedPieceId = piece.pieceId;
  state.selectedRotation = 0;
  state.selectedFlipped = false;
  state.previewAnchor = null;
  state.preview = null;
  state.message = `已选中${COLOR_LABEL[piece.color]}色拼块，滑动棋盘选择落点`;
  render();
}

function refreshPreviewForCurrentAnchor(successMessage) {
  if (!state.previewAnchor) {
    state.message = successMessage;
    render();
    return;
  }

  const clamped = getClampedAnchorForSelectedPiece(state.previewAnchor.row, state.previewAnchor.col);
  state.previewAnchor = { row: clamped.row, col: clamped.col };
  const move = buildMove(clamped.row, clamped.col);
  state.preview = buildPreview(move);
  state.message = state.preview?.valid
    ? "这里可以放置"
    : `这里放不下：${state.preview?.reason || "换个位置试试"}`;
  render();
}

function rotateSelectedPiece() {
  if (state.pendingPlacement) {
    state.message = "这一步已落子，点击“下一回合”继续";
    render();
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "先从左侧选一个拼块";
    render();
    return;
  }

  state.selectedRotation = (state.selectedRotation + 90) % 360;
  refreshPreviewForCurrentAnchor(`已旋转到 ${state.selectedRotation}°`);
}

function flipSelectedPiece() {
  if (state.pendingPlacement) {
    state.message = "这一步已落子，点击“下一回合”继续";
    render();
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "先从左侧选一个拼块";
    render();
    return;
  }

  state.selectedFlipped = !state.selectedFlipped;
  refreshPreviewForCurrentAnchor(state.selectedFlipped ? "已翻转拼块" : "已恢复原镜像");
}

function updatePreviewAt(row, col) {
  if (state.pendingPlacement) {
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "先从左侧选一个拼块";
    render();
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  const clamped = getClampedAnchorForSelectedPiece(row, col);
  const move = buildMove(clamped.row, clamped.col);
  state.previewAnchor = { row: clamped.row, col: clamped.col };
  state.preview = buildPreview(move);
  state.message = state.preview?.valid
    ? "这里可以放置"
    : `这里放不下：${state.preview?.reason || "换个位置试试"}`;
  render();
}

function getBoardCellFromPointer(event) {
  const directCell = event.target instanceof Element ? event.target.closest(".board-cell") : null;
  if (directCell && state.dom.board.contains(directCell)) {
    return directCell;
  }

  const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
  if (!(pointTarget instanceof Element)) {
    return null;
  }

  const pointedCell = pointTarget.closest(".board-cell");
  if (!pointedCell || !state.dom.board.contains(pointedCell)) {
    return null;
  }

  return pointedCell;
}

function updatePreviewFromPointer(event) {
  if (!state.selectedPieceId) {
    return;
  }

  const cell = getBoardCellFromPointer(event);
  if (!cell) {
    return;
  }

  const row = Number(cell.dataset.row);
  const col = Number(cell.dataset.col);

  if (Number.isNaN(row) || Number.isNaN(col)) {
    return;
  }

  if (state.previewAnchor && state.previewAnchor.row === row && state.previewAnchor.col === col) {
    return;
  }

  updatePreviewAt(row, col);
}

function startBoardPointerTracking(event) {
  if (state.pendingPlacement) {
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "先从左侧选一个拼块";
    render();
    return;
  }

  state.boardPointer.active = true;
  state.boardPointer.pointerId = event.pointerId;

  if (state.dom.board.setPointerCapture) {
    try {
      state.dom.board.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Ignore capture failures on unsupported environments.
    }
  }

  updatePreviewFromPointer(event);
  renderFloatingPreview();
  event.preventDefault();
}

function handleBoardPointerMove(event) {
  if (!state.boardPointer.active || state.boardPointer.pointerId !== event.pointerId) {
    return;
  }

  updatePreviewFromPointer(event);
  renderFloatingPreview();
  event.preventDefault();
}

function stopBoardPointerTracking(event) {
  if (state.boardPointer.pointerId !== event.pointerId) {
    return;
  }

  if (state.dom.board.releasePointerCapture) {
    try {
      state.dom.board.releasePointerCapture(event.pointerId);
    } catch (_error) {
      // Ignore release failures on unsupported environments.
    }
  }

  state.boardPointer.active = false;
  state.boardPointer.pointerId = null;
  renderFloatingPreview();
}

function buildPlaceSuccessMessage(result, move) {
  const placedColor = result.placedColor;
  const skipped = result.skippedColors || [];

  let text = `${getPlayerNameByColor(placedColor)}放置${COLOR_LABEL[placedColor]}色拼块成功`;
  if (skipped.length) {
    text += `，${skipped.map((color) => `${COLOR_LABEL[color]}色`).join("、")}暂时无路可走，已自动跳过`;
  }

  if (result.state.gameOver) {
    text += "。四种颜色都无法继续落子，对局结束";
  } else {
    text += `，接下来是${getPlayerNameByColor(result.state.currentTurnColor)}的${COLOR_LABEL[result.state.currentTurnColor]}色回合`;
  }

  return text;
}

async function syncRoomFromServer(message) {
  if (!state.network.client || !state.network.roomId) {
    return;
  }

  const latest = await sbLoadRoom(state.network.client, state.network.roomId);
  if (!latest) {
    throw new Error("房间不存在或已删除");
  }

  applyRoomSnapshot(latest, {
    message: message || "已同步到最新对局状态",
    fromRealtime: false,
  });
}

async function placePiece() {
  if (state.network.syncingMove) {
    return;
  }

  if (state.pendingPlacement) {
    const moveSnapshot = { ...state.pendingPlacement.move };
    const recheck = canPlaceMove(state.game, moveSnapshot);
    if (!recheck.valid) {
      state.pendingPlacement = null;
      state.message = `该落子已失效：${recheck.reason}`;
      render();
      return;
    }

    const localResult = applyMove(state.game, moveSnapshot);
    if (!localResult.ok) {
      state.pendingPlacement = null;
      state.message = `这一步暂时行不通：${localResult.reason}`;
      render();
      return;
    }

    const message = buildPlaceSuccessMessage(localResult, moveSnapshot);
    state.network.syncingMove = true;
    render();

    try {
      const payload = {
        game_state: serializeRoomGameState(localResult.state, state.roomConfig),
        current_turn_color: localResult.state.currentTurnColor,
        status: localResult.state.gameOver ? "finished" : "playing",
        winner: localResult.state.winner,
        updated_at: new Date().toISOString(),
      };

      const updatedRoom = await sbUpdateRoomState(
        state.network.client,
        state.network.roomId,
        payload,
        state.network.lastRoomUpdatedAt
      );

      applyRoomSnapshot(updatedRoom, {
        message,
        fromRealtime: false,
      });

      if (typeof sbInsertMove === "function") {
        sbInsertMove(state.network.client, {
          roomId: state.network.roomId,
          turnNumber: state.game.turnCount - 1,
          color: localResult.placedColor,
          pieceId: moveSnapshot.pieceId,
          rotation: moveSnapshot.rotation,
          flipped: moveSnapshot.flipped,
          anchorRow: moveSnapshot.anchorRow,
          anchorCol: moveSnapshot.anchorCol,
          createdBy: state.network.userId,
        }).catch((error) => {
          console.warn("记录 moves 日志失败:", error);
        });
      }
    } catch (error) {
      try {
        await syncRoomFromServer("房间有新变化，已自动刷新到最新局面");
      } catch (_syncError) {
        state.message = `落子未完成：${error.message || String(error)}`;
        render();
      }
    } finally {
      state.network.syncingMove = false;
      render();
    }
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "先从左侧选一个拼块";
    render();
    return;
  }

  if (!state.preview) {
    state.message = "先在棋盘上滑动预览落点";
    render();
    return;
  }

  if (!state.preview.valid) {
    state.message = `这里放不下：${state.preview.reason}`;
    render();
    return;
  }

  state.pendingPlacement = {
    move: { ...state.preview.move },
    color: state.preview.color,
    cells: state.preview.cells.map((cell) => ({ row: cell.row, col: cell.col })),
  };
  state.selectedPieceId = null;
  state.selectedRotation = 0;
  state.selectedFlipped = false;
  state.previewAnchor = null;
  state.preview = null;
  state.message = "已落子，确认无误后点击“下一回合”";
  render();
}

function startPieceLongPress(event, card, pieceId) {
  clearPiecePoolGestureState();

  state.piecePoolGesture.pointerId = event.pointerId;
  state.piecePoolGesture.pieceId = pieceId;
  state.piecePoolGesture.startX = event.clientX;
  state.piecePoolGesture.startY = event.clientY;
  state.piecePoolGesture.longPressTriggered = false;

  state.piecePoolGesture.timerId = setTimeout(() => {
    state.piecePoolGesture.longPressTriggered = true;
    state.piecePoolGesture.suppressClick = true;

    if (state.piecePoolGesture.suppressTimerId !== null) {
      clearTimeout(state.piecePoolGesture.suppressTimerId);
    }

    state.piecePoolGesture.suppressTimerId = setTimeout(() => {
      state.piecePoolGesture.suppressClick = false;
      state.piecePoolGesture.suppressTimerId = null;
    }, 500);

    flipSelectedPiece();
  }, PIECE_LONG_PRESS_MS);

  if (card.setPointerCapture) {
    try {
      card.setPointerCapture(event.pointerId);
    } catch (_error) {
      // Ignore capture failures on unsupported environments.
    }
  }
}

function handlePiecePoolPointerDown(event) {
  const card = event.target.closest(".piece-card");
  if (!card) {
    clearPiecePoolGestureState();
    return;
  }

  if (getCannotOperateReason()) {
    return;
  }

  const pieceId = card.dataset.pieceId;
  if (!pieceId || pieceId !== state.selectedPieceId) {
    clearPiecePoolGestureState();
    return;
  }

  const piece = getPieceById(pieceId);
  if (!piece || piece.used || !canUseColorThisTurn(piece.color) || !canClientUseColor(piece.color)) {
    clearPiecePoolGestureState();
    return;
  }

  startPieceLongPress(event, card, pieceId);
}

function maybeCancelPieceLongPressOnMove(event) {
  if (
    state.piecePoolGesture.pointerId === null ||
    state.piecePoolGesture.pointerId !== event.pointerId ||
    state.piecePoolGesture.timerId === null
  ) {
    return;
  }

  const dx = event.clientX - state.piecePoolGesture.startX;
  const dy = event.clientY - state.piecePoolGesture.startY;
  const moved = Math.hypot(dx, dy);

  if (moved > PIECE_LONG_PRESS_MOVE_CANCEL) {
    clearPiecePoolGestureState();
  }
}

function finishPieceLongPress(event) {
  if (
    state.piecePoolGesture.pointerId === null ||
    state.piecePoolGesture.pointerId !== event.pointerId
  ) {
    return;
  }

  const card = event.target.closest(".piece-card");
  if (card && card.releasePointerCapture) {
    try {
      card.releasePointerCapture(event.pointerId);
    } catch (_error) {
      // Ignore release failures when pointer was not captured.
    }
  }

  clearPiecePoolGestureState();
}

function handlePiecePoolClick(event) {
  const card = event.target.closest(".piece-card");
  if (!card) {
    return;
  }

  if (state.piecePoolGesture.suppressClick) {
    if (state.piecePoolGesture.suppressTimerId !== null) {
      clearTimeout(state.piecePoolGesture.suppressTimerId);
      state.piecePoolGesture.suppressTimerId = null;
    }
    state.piecePoolGesture.suppressClick = false;
    return;
  }

  const pieceId = card.dataset.pieceId;
  if (!pieceId) {
    return;
  }

  const piece = getPieceById(pieceId);
  if (!piece) {
    return;
  }

  if (
    pieceId === state.selectedPieceId &&
    !piece.used &&
    canCurrentClientOperate() &&
    canUseColorThisTurn(piece.color)
  ) {
    const now = Date.now();
    const tapDelta = now - state.piecePoolGesture.lastTapAt;
    if (
      state.piecePoolGesture.lastTapPieceId === pieceId &&
      tapDelta >= 0 &&
      tapDelta <= 320
    ) {
      state.piecePoolGesture.lastTapPieceId = null;
      state.piecePoolGesture.lastTapAt = 0;
      rotateSelectedPiece();
      return;
    }

    state.piecePoolGesture.lastTapPieceId = pieceId;
    state.piecePoolGesture.lastTapAt = now;
  } else {
    state.piecePoolGesture.lastTapPieceId = null;
    state.piecePoolGesture.lastTapAt = 0;
  }

  selectPiece(pieceId);
}

function syncAppViewportHeight() {
  const root = document.documentElement;
  const visualHeight = window.visualViewport?.height;
  const nextHeight = Math.floor(visualHeight || window.innerHeight || 0);

  if (nextHeight > 0) {
    root.style.setProperty("--app-height", `${nextHeight}px`);
  }
}

function updateLayout() {
  const root = document.documentElement;
  const app = document.getElementById("app");
  const shell = document.querySelector(".main-shell");
  const boardArea = state.dom.boardArea;
  syncAppViewportHeight();

  const viewportW = Math.floor(window.visualViewport?.width || window.innerWidth || 0);
  const viewportH = Math.floor(window.visualViewport?.height || window.innerHeight || 0);
  if (state.view !== "game") {
    document.body.classList.remove("portrait");
    root.style.setProperty("--main-shell-height", "auto");
    return;
  }

  document.body.classList.toggle("portrait", viewportW < viewportH);

  if (!app || !shell || !boardArea) {
    return;
  }

  const mainShellHeight = Math.max(0, Math.floor(shell.clientHeight));
  root.style.setProperty("--main-shell-height", `${mainShellHeight}px`);
  const boardAreaWidth = Math.max(0, Math.floor(boardArea.clientWidth));
  const maxByHeight = Math.max(0, mainShellHeight - 2);
  const softMaxByViewport = Math.max(0, viewportH - 8);
  const nextBoardSize = Math.floor(Math.min(boardAreaWidth, maxByHeight, softMaxByViewport));
  if (Number.isFinite(nextBoardSize) && nextBoardSize > 0) {
    root.style.setProperty("--board-size", `${nextBoardSize}px`);
  }
}

function scheduleGameLayoutRefresh() {
  if (state.layout.gameRefreshScheduled) {
    return;
  }

  state.layout.gameRefreshScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      state.layout.gameRefreshScheduled = false;
      if (state.view !== "game") {
        return;
      }
      updateLayout();
      render();
    });
  });
}

function cancelPendingPlacement() {
  const pending = state.pendingPlacement;
  if (!pending) {
    clearSelection("已取消当前选择");
    return;
  }

  state.pendingPlacement = null;
  state.selectedPieceId = pending.move.pieceId;
  state.selectedRotation = Number(pending.move.rotation) || 0;
  state.selectedFlipped = Boolean(pending.move.flipped);
  state.previewAnchor = {
    row: Number(pending.move.anchorRow),
    col: Number(pending.move.anchorCol),
  };
  state.preview = buildPreview(pending.move);
  state.message = "已撤回确认，可继续调整这一步";
  render();
}

function buildRealtimeSyncMessage(room) {
  const status = room.status || "waiting";
  if (status === "finished" || state.game.gameOver) {
    return "已同步：对局结束";
  }

  if (status === "waiting") {
    return "已同步：等待玩家就位";
  }

  if (canCurrentClientOperate()) {
    return `已同步：轮到你行动（${COLOR_LABEL[getCurrentTurnColor()]}色）`;
  }

  return `已同步：等待${COLOR_LABEL[getCurrentTurnColor()]}色玩家`;
}

function applyRoomSnapshot(room, options = {}) {
  if (!room) {
    return;
  }

  if (
    options.fromRealtime &&
    state.network.lastRoomUpdatedAt &&
    room.updated_at &&
    state.network.lastRoomUpdatedAt === room.updated_at
  ) {
    return;
  }

  state.network.room = room;
  state.network.roomId = room.id;
  state.network.lastRoomUpdatedAt = room.updated_at || null;
  const parsedRoomState = parseRoomGameState(room.game_state, room);
  state.roomConfig = parsedRoomState.config;
  state.lobby.mode = parsedRoomState.config.mode;
  state.game = parsedRoomState.game;
  state.network.role = getRoleByRoom(room, state.network.userId);
  if (/^player[1-4]$/.test(state.network.role)) {
    state.lobby.nickname =
      parsedRoomState.config.playerNicknameMap[state.network.role] ||
      getDefaultNicknameBySeat(state.network.role);
  }

  clearTransientSelection();
  state.lastScrolledTurnColor = null;

  if (typeof options.message === "string") {
    state.message = options.message;
  } else if (options.fromRealtime) {
    state.message = buildRealtimeSyncMessage(room);
  }

  const roomStatus = room.status || "waiting";
  if (roomStatus === "playing" || roomStatus === "finished") {
    state.waitingDismissed = false;
    setView("game");
  } else {
    setView(state.waitingDismissed ? "lobby" : "waiting");
  }

  render();
  if (state.view === "game") {
    scheduleGameLayoutRefresh();
  } else {
    updateLayout();
  }
}

function subscribeCurrentRoom(roomId) {
  clearRoomSubscription();

  if (!state.network.client || !roomId || typeof sbSubscribeToRoom !== "function") {
    return;
  }

  state.network.unsubscribeRoom = sbSubscribeToRoom(state.network.client, roomId, (nextRoom) => {
    applyRoomSnapshot(nextRoom, { fromRealtime: true });
  });
}

async function ensureNetworkReady() {
  if (state.network.ready) {
    return true;
  }

  if (!supabaseApi) {
    state.message = "supabase.js 未加载";
    render();
    return false;
  }

  if (
    typeof sbCreateSupabaseClient !== "function" ||
    typeof sbEnsureAnonymousAuth !== "function"
  ) {
    state.message = "Supabase 接口未完整初始化";
    render();
    return false;
  }

  try {
    const client = await sbCreateSupabaseClient();
    const user = await sbEnsureAnonymousAuth(client);

    state.network.client = client;
    state.network.userId = user.id;
    state.network.ready = true;
    render();
    return true;
  } catch (error) {
    state.message = `联机初始化失败：${error.message || String(error)}`;
    render();
    return false;
  }
}

async function claimSeatAndMaybeUpdateRoom(room, preferredNickname) {
  const parsed = parseRoomGameState(room.game_state, room);
  const config = {
    mode: parsed.config.mode,
    colorOwner: { ...parsed.config.colorOwner },
    playerUserMap: { ...parsed.config.playerUserMap },
    playerNicknameMap: { ...parsed.config.playerNicknameMap },
    playerReadyMap: { ...parsed.config.playerReadyMap },
  };
  const seats = getPlayerSeatsByMode(config.mode);

  let role = getRoleByRoomConfig(config, state.network.userId);
  let changed = false;
  const nickname = String(preferredNickname || "").trim();
  const canClaimSeat = (room.status || "waiting") === "waiting";

  if (role === "spectator" && canClaimSeat) {
    const emptySeat = seats.find((seat) => !config.playerUserMap[seat]);
    if (emptySeat) {
      config.playerUserMap[emptySeat] = state.network.userId;
      config.playerNicknameMap[emptySeat] = nickname || getDefaultNicknameBySeat(emptySeat);
      config.playerReadyMap[emptySeat] = false;
      role = emptySeat;
      changed = true;
    }
  } else if (/^player[1-4]$/.test(role)) {
    const nextNickname = nickname || config.playerNicknameMap[role] || getDefaultNicknameBySeat(role);
    if (config.playerNicknameMap[role] !== nextNickname) {
      config.playerNicknameMap[role] = nextNickname;
      changed = true;
    }
  }

  const expectedStatus = getExpectedRoomStatusByConfig(parsed.game, config, room.status);
  const expectedHost = config.playerUserMap.player1 || room.host_user_id || null;
  const expectedGuest = config.playerUserMap.player2 || room.guest_user_id || null;
  const shouldUpdateRoom =
    changed ||
    room.status !== expectedStatus ||
    room.current_turn_color !== parsed.game.currentTurnColor ||
    room.host_user_id !== expectedHost ||
    room.guest_user_id !== expectedGuest;

  if (!shouldUpdateRoom) {
    return {
      room,
      role,
      config,
    };
  }

  const payload = {
    host_user_id: expectedHost,
    guest_user_id: expectedGuest,
    status: expectedStatus,
    current_turn_color: parsed.game.currentTurnColor,
    game_state: serializeRoomGameState(parsed.game, config),
    winner: parsed.game.winner,
    updated_at: new Date().toISOString(),
  };

  try {
    const updated = await sbUpdateRoomState(
      state.network.client,
      room.id,
      payload,
      room.updated_at || null
    );
    return {
      room: updated,
      role,
      config,
    };
  } catch (_error) {
    const latest = await sbLoadRoom(state.network.client, room.id);
    if (!latest) {
      throw new Error("房间不存在或已删除");
    }
    const latestParsed = parseRoomGameState(latest.game_state, latest);
    return {
      room: latest,
      role: getRoleByRoomConfig(latestParsed.config, state.network.userId),
      config: latestParsed.config,
    };
  }
}

async function createOnlineRoom(options = {}) {
  const mode = normalizeGameMode(options.mode || state.lobby.mode);
  const roomCode = normalizeRoomCode(options.roomCode);
  const nickname = String(
    options.nickname !== undefined ? options.nickname : getLobbyNicknameInputValue()
  ).trim();

  if (!roomCode) {
    updateLobbyStatus("创建失败：房间码不能为空");
    render();
    return false;
  }

  if (state.network.creatingRoom) {
    return false;
  }

  if (!(await ensureNetworkReady())) {
    updateLobbyStatus(state.message);
    render();
    return false;
  }

  if (state.network.roomId) {
    state.message = "当前已在房间中，若要新开房请使用新页面";
    updateLobbyStatus(state.message);
    render();
    return false;
  }

  state.network.creatingRoom = true;
  render();

  try {
    const initialGame = createInitialGameState();
    const roomConfig = createDefaultRoomConfig(mode);
    roomConfig.playerUserMap.player1 = state.network.userId;
    roomConfig.playerNicknameMap.player1 = nickname || getDefaultNicknameBySeat("player1");
    const initialStatus = getExpectedRoomStatusByConfig(initialGame, roomConfig, "waiting");
    const room = await sbCreateRoom(state.network.client, {
      roomId: roomCode,
      hostUserId: state.network.userId,
      status: initialStatus,
      currentTurnColor: initialGame.currentTurnColor,
      gameState: serializeRoomGameState(initialGame, roomConfig),
      winner: null,
    });

    setRoomIdToUrl(room.id);
    subscribeCurrentRoom(room.id);
    state.waitingDismissed = false;
    const waitingSeats = getPlayerSeatsByMode(mode).slice(1).map((seat) => getSeatLabel(seat));
    applyRoomSnapshot(room, {
      message:
        waitingSeats.length > 0
          ? `房间 ${room.id} 创建成功，等待${waitingSeats.join("、")}加入`
          : `房间 ${room.id} 创建成功`,
      fromRealtime: false,
    });
    updateLobbyStatus(`房间 ${room.id} 创建成功`);
    return true;
  } catch (error) {
    state.message = `创建房间失败：${error.message || String(error)}`;
    updateLobbyStatus(state.message);
    render();
    return false;
  } finally {
    state.network.creatingRoom = false;
    render();
  }
}

async function joinRoomByCode(roomIdInput, nicknameInput) {
  const roomId = normalizeRoomCode(roomIdInput);
  const nickname = String(
    nicknameInput !== undefined ? nicknameInput : getLobbyNicknameInputValue()
  ).trim();

  if (!roomId) {
    updateLobbyStatus("加入失败：房间码不能为空");
    render();
    return false;
  }

  if (!(await ensureNetworkReady())) {
    updateLobbyStatus(state.message);
    render();
    return false;
  }

  state.network.initializing = true;
  render();

  try {
    const loaded = await sbLoadRoom(state.network.client, roomId);
    if (!loaded) {
      throw new Error("房间不存在");
    }

    const resolved = await claimSeatAndMaybeUpdateRoom(loaded, nickname);
    setRoomIdToUrl(resolved.room.id);
    subscribeCurrentRoom(resolved.room.id);
    state.waitingDismissed = false;
    const modeLabel = resolved.config.mode === GAME_MODE_FOUR_PLAYER ? "4人模式" : "2人模式";
    applyRoomSnapshot(resolved.room, {
      message: `已进入房间 ${resolved.room.id}（${modeLabel}，身份：${getSeatLabel(resolved.role)}）`,
      fromRealtime: false,
    });
    updateLobbyStatus(`加入成功：${resolved.room.id}`);
    return true;
  } catch (error) {
    state.message = `加入房间失败：${error.message || String(error)}`;
    updateLobbyStatus(state.message);
    render();
    return false;
  } finally {
    state.network.initializing = false;
    render();
  }
}

async function copyRoomLink() {
  if (!state.network.roomId) {
    state.message = "当前没有房间链接可复制";
    render();
    return;
  }

  const link = getRoomLink(state.network.roomId);

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(link);
      state.message = "房间链接已复制";
    } else {
      window.prompt("复制房间链接", link);
      state.message = "已打开复制窗口";
    }
  } catch (_error) {
    window.prompt("复制房间链接", link);
    state.message = "复制失败，已打开手动复制窗口";
  }

  render();
}

async function updateRoomWithConfig(config, options = {}) {
  if (!state.network.client || !state.network.roomId || !state.network.room) {
    return false;
  }

  const payload = {
    game_state: serializeRoomGameState(state.game, config),
    status: options.status || state.network.room.status || "waiting",
    current_turn_color: options.currentTurnColor || state.game.currentTurnColor,
    winner: options.winner !== undefined ? options.winner : state.game.winner,
    updated_at: new Date().toISOString(),
  };

  try {
    const updatedRoom = await sbUpdateRoomState(
      state.network.client,
      state.network.roomId,
      payload,
      state.network.lastRoomUpdatedAt
    );
    applyRoomSnapshot(updatedRoom, {
      message: options.message || state.message,
      fromRealtime: false,
    });
    return true;
  } catch (error) {
    try {
      await syncRoomFromServer("房间有新变化，已自动刷新到最新局面");
    } catch (_syncError) {
      state.message = options.errorMessage || `操作未完成：${error.message || String(error)}`;
      render();
    }
    return false;
  }
}

function handleWaitingBack() {
  state.waitingDismissed = true;
  setView("lobby");
  updateLobbyStatus(state.network.roomId ? `你仍在房间 ${state.network.roomId} 中` : state.lobby.status);
  render();
}

async function handleLobbyReturnRoom() {
  if (!state.network.roomId) {
    return;
  }

  if (!state.network.room && state.network.client) {
    try {
      const latest = await sbLoadRoom(state.network.client, state.network.roomId);
      if (latest) {
        applyRoomSnapshot(latest, {
          message: `已返回房间 ${state.network.roomId}`,
          fromRealtime: false,
        });
        return;
      }
    } catch (_error) {
      // Ignore load failure and fallback to local state.
    }
  }

  if (!state.network.room) {
    state.message = "当前房间不可用，请重新加入";
    render();
    return;
  }

  state.waitingDismissed = false;
  const roomStatus = state.network.room.status || "waiting";
  setView(roomStatus === "waiting" ? "waiting" : "game");
  render();
  if (state.view === "game") {
    scheduleGameLayoutRefresh();
  } else {
    updateLayout();
  }
}

async function toggleReadyInWaitingRoom() {
  if (!state.network.room || state.network.room.status !== "waiting") {
    state.message = "当前不在准备阶段";
    render();
    return;
  }

  if (!/^player[1-4]$/.test(state.network.role)) {
    state.message = "观战模式下无法设置准备状态";
    render();
    return;
  }

  const role = state.network.role;
  const nextConfig = {
    ...state.roomConfig,
    playerUserMap: { ...state.roomConfig.playerUserMap },
    playerNicknameMap: { ...state.roomConfig.playerNicknameMap },
    playerReadyMap: { ...state.roomConfig.playerReadyMap },
  };
  const nextReady = !Boolean(nextConfig.playerReadyMap[role]);
  nextConfig.playerReadyMap[role] = nextReady;

  await updateRoomWithConfig(nextConfig, {
    status: "waiting",
    message: nextReady ? "你已准备，等待其他玩家" : "已取消准备",
    errorMessage: "准备状态更新失败，请稍后再试",
  });
}

async function startGameFromWaitingRoom() {
  if (!state.network.room || state.network.room.status !== "waiting") {
    state.message = "当前不在准备阶段";
    render();
    return;
  }

  if (!isCurrentUserHost()) {
    state.message = "只有房主可以开始游戏";
    render();
    return;
  }

  if (!canHostStartGame()) {
    state.message = "需要全员入座并全部准备后才能开始";
    render();
    return;
  }

  await updateRoomWithConfig(state.roomConfig, {
    status: "playing",
    message: "游戏开始，正在进入棋盘",
    errorMessage: "开始游戏失败，请重试",
  });
}

function handleLobbyModeChange(mode) {
  setLobbyMode(mode);
  render();
}

function handleLobbyNicknameInput(event) {
  state.lobby.nickname = String(event.target.value || "").trim();
}

function openLobbyCreatePanel() {
  setLobbyAction(LOBBY_ACTION_CREATE);
  render();
}

function openLobbyJoinPanel() {
  setLobbyAction(LOBBY_ACTION_JOIN);
  render();
}

async function handleLobbyCreateConfirm() {
  const roomCode = state.dom.lobby.createRoomCodeInput?.value || "";
  const ok = await createOnlineRoom({
    roomCode,
    mode: state.lobby.mode,
    nickname: getLobbyNicknameInputValue(),
  });
  if (ok) {
    setLobbyAction(LOBBY_ACTION_NONE);
    render();
  }
}

async function handleLobbyJoinConfirm() {
  const roomCode = state.dom.lobby.joinRoomCodeInput?.value || "";
  const ok = await joinRoomByCode(roomCode, getLobbyNicknameInputValue());
  if (ok) {
    setLobbyAction(LOBBY_ACTION_NONE);
    render();
  }
}

function bindEvents() {
  state.dom.piecePool.addEventListener("click", handlePiecePoolClick);
  state.dom.piecePool.addEventListener("pointerdown", handlePiecePoolPointerDown);
  state.dom.piecePool.addEventListener("pointermove", maybeCancelPieceLongPressOnMove);
  state.dom.piecePool.addEventListener("pointerup", finishPieceLongPress);
  state.dom.piecePool.addEventListener("pointercancel", finishPieceLongPress);

  state.dom.board.addEventListener("pointerdown", startBoardPointerTracking);
  state.dom.board.addEventListener("pointermove", handleBoardPointerMove);
  state.dom.board.addEventListener("pointerup", stopBoardPointerTracking);
  state.dom.board.addEventListener("pointercancel", stopBoardPointerTracking);

  state.dom.buttons.rotate.addEventListener("click", rotateSelectedPiece);
  state.dom.buttons.flip.addEventListener("click", flipSelectedPiece);
  state.dom.buttons.place.addEventListener("click", placePiece);
  state.dom.buttons.cancel.addEventListener("click", cancelPendingPlacement);
  state.dom.buttons.copyRoomLink?.addEventListener("click", copyRoomLink);

  state.dom.waiting.backBtn?.addEventListener("click", handleWaitingBack);
  state.dom.waiting.readyBtn?.addEventListener("click", toggleReadyInWaitingRoom);
  state.dom.waiting.startBtn?.addEventListener("click", startGameFromWaitingRoom);
  state.dom.lobby.returnRoomBtn?.addEventListener("click", handleLobbyReturnRoom);

  if (state.dom.lobby.nicknameInput) {
    state.dom.lobby.nicknameInput.addEventListener("input", handleLobbyNicknameInput);
  }
  state.dom.lobby.mode2Btn?.addEventListener("click", () => handleLobbyModeChange(GAME_MODE_TWO_PLAYER));
  state.dom.lobby.mode4Btn?.addEventListener("click", () => handleLobbyModeChange(GAME_MODE_FOUR_PLAYER));
  state.dom.lobby.createToggleBtn?.addEventListener("click", openLobbyCreatePanel);
  state.dom.lobby.joinToggleBtn?.addEventListener("click", openLobbyJoinPanel);
  state.dom.lobby.createBackBtn?.addEventListener("click", () => {
    setLobbyAction(LOBBY_ACTION_NONE);
    render();
  });
  state.dom.lobby.joinBackBtn?.addEventListener("click", () => {
    setLobbyAction(LOBBY_ACTION_NONE);
    render();
  });
  state.dom.lobby.createConfirmBtn?.addEventListener("click", handleLobbyCreateConfirm);
  state.dom.lobby.joinConfirmBtn?.addEventListener("click", handleLobbyJoinConfirm);

  window.addEventListener("resize", updateLayout);
  window.addEventListener("orientationchange", updateLayout);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateLayout);
    window.visualViewport.addEventListener("scroll", updateLayout);
  }
}

function cacheDom() {
  state.dom.lobbyView = document.getElementById("lobbyView");
  state.dom.waitingView = document.getElementById("waitingView");
  state.dom.gameView = document.getElementById("gameView");
  state.dom.board = document.getElementById("board");
  state.dom.boardArea = document.querySelector(".board-area");
  state.dom.piecePool = document.getElementById("piecePool");
  state.dom.floatingPiece = document.getElementById("floatingPiece");
  state.dom.floatingPieceGrid = document.getElementById("floatingPieceGrid");

  state.dom.lobby = {
    nicknameInput: document.getElementById("lobbyNicknameInput"),
    mode2Btn: document.getElementById("lobbyMode2Btn"),
    mode4Btn: document.getElementById("lobbyMode4Btn"),
    createToggleBtn: document.getElementById("lobbyCreateToggleBtn"),
    joinToggleBtn: document.getElementById("lobbyJoinToggleBtn"),
    createPanel: document.getElementById("lobbyCreatePanel"),
    joinPanel: document.getElementById("lobbyJoinPanel"),
    createRoomCodeInput: document.getElementById("lobbyCreateRoomCodeInput"),
    joinRoomCodeInput: document.getElementById("lobbyJoinRoomCodeInput"),
    createBackBtn: document.getElementById("lobbyCreateBackBtn"),
    joinBackBtn: document.getElementById("lobbyJoinBackBtn"),
    createConfirmBtn: document.getElementById("lobbyCreateConfirmBtn"),
    joinConfirmBtn: document.getElementById("lobbyJoinConfirmBtn"),
    statusText: document.getElementById("lobbyStatusText"),
    returnRoomBtn: document.getElementById("lobbyReturnRoomBtn"),
  };

  state.dom.waiting = {
    backBtn: document.getElementById("waitingBackBtn"),
    roomCodeText: document.getElementById("waitingRoomCodeText"),
    playerCountText: document.getElementById("waitingPlayerCountText"),
    playersList: document.getElementById("waitingPlayersList"),
    readyBtn: document.getElementById("waitingReadyBtn"),
    startBtn: document.getElementById("waitingStartBtn"),
    hintText: document.getElementById("waitingHintText"),
  };

  state.dom.buttons = {
    rotate: document.getElementById("btnRotate"),
    flip: document.getElementById("btnFlip"),
    place: document.getElementById("btnPlace"),
    cancel: document.getElementById("btnCancel"),
    copyRoomLink: document.getElementById("btnCopyRoomLink"),
  };

  state.dom.ui = {
    turnPlayer: document.getElementById("turnPlayer"),
    turnNumber: document.getElementById("turnNumber"),
    turnColors: document.getElementById("turnColors"),
    turnMode: document.getElementById("turnMode"),
    statusText: document.getElementById("statusText"),
    resultCard: document.getElementById("resultCard"),
    resultText: document.getElementById("resultText"),
    scoreList: document.getElementById("scoreList"),
    remainBlue: document.getElementById("remainBlue"),
    remainYellow: document.getElementById("remainYellow"),
    remainGreen: document.getElementById("remainGreen"),
    remainRed: document.getElementById("remainRed"),
    placedBlue: document.getElementById("placedBlue"),
    placedYellow: document.getElementById("placedYellow"),
    placedGreen: document.getElementById("placedGreen"),
    placedRed: document.getElementById("placedRed"),
    cellsRemainBlue: document.getElementById("cellsRemainBlue"),
    cellsRemainYellow: document.getElementById("cellsRemainYellow"),
    cellsRemainGreen: document.getElementById("cellsRemainGreen"),
    cellsRemainRed: document.getElementById("cellsRemainRed"),
    roomCode: document.getElementById("roomCode"),
    roomStatus: document.getElementById("roomStatus"),
    roomCanAct: document.getElementById("roomCanAct"),
    roomHint: document.getElementById("roomHint"),
    piecePoolHint: document.getElementById("piecePoolHint"),
  };
}

function registerStateLayerApi() {
  window.BlokusStateLayer = {
    exportGameState() {
      return serializeGameState(state.game);
    },
    importGameState(data) {
      try {
        state.game = deserializeGameState(data);
        state.lastScrolledTurnColor = null;
        clearSelection("已从序列化数据恢复对局");
        return { ok: true };
      } catch (error) {
        state.message = "状态恢复失败";
        render();
        return { ok: false, error: String(error) };
      }
    },
    getGameStateObject() {
      return JSON.parse(serializeGameState(state.game));
    },
  };
}

async function init() {
  cacheDom();
  createBoard();
  createPiecePool();
  bindEvents();
  registerStateLayerApi();
  setView("lobby");
  updateLayout();
  const presetRoom = getRoomIdFromUrl();
  if (presetRoom && state.dom.lobby.joinRoomCodeInput) {
    state.dom.lobby.joinRoomCodeInput.value = presetRoom;
    updateLobbyStatus("已从链接读取房间码，点击“加入房间”后确认加入");
  }
  render();

  await ensureNetworkReady();
}

init();

window.addEventListener("beforeunload", () => {
  clearRoomSubscription();
});

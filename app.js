const engine = window.BlokusEngine;
const supabaseApi = window.BlokusSupabase || null;

if (!engine) {
  throw new Error("BlokusEngine 未加载，请先引入 engine.js");
}

const {
  BOARD_SIZE,
  SHAPES,
  TURN_ORDER,
  COLOR_ORDER,
  COLOR_LABEL,
  PLAYER_BY_COLOR,
  PLAYER_CONFIG,
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
  joinRoom: sbJoinRoom,
  loadRoom: sbLoadRoom,
  updateRoomState: sbUpdateRoomState,
  subscribeToRoom: sbSubscribeToRoom,
  insertMove: sbInsertMove,
} = supabaseApi || {};

const PIECE_LONG_PRESS_MS = 420;
const PIECE_LONG_PRESS_MOVE_CANCEL = 8;

const ROLE_COLORS = {
  host: ["blue", "yellow"],
  guest: ["red", "green"],
  spectator: [],
  none: [],
};

const ROLE_LABEL = {
  host: "玩家1（蓝/黄）",
  guest: "玩家2（红/绿）",
  spectator: "观战",
  none: "未加入",
};

const ROOM_STATUS_LABEL = {
  waiting: "等待中",
  playing: "对局中",
  finished: "已结束",
};

const state = {
  game: createInitialGameState(),
  selectedPieceId: null,
  selectedRotation: 0,
  selectedFlipped: false,
  previewAnchor: null,
  preview: null,
  message: "请创建房间，或通过房间链接加入",
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
  dom: {
    board: null,
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
  return PLAYER_BY_COLOR[color];
}

function getPlayerNameByColor(color) {
  const player = getPlayerByColor(color);
  return PLAYER_CONFIG[player]?.name || "玩家";
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

function getRoleByRoom(room, userId) {
  if (!room || !userId) {
    return "none";
  }

  if (room.host_user_id === userId) {
    return "host";
  }

  if (room.guest_user_id === userId) {
    return "guest";
  }

  return "spectator";
}

function canClientUseColor(color) {
  const available = ROLE_COLORS[state.network.role] || [];
  return available.includes(color);
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

function getCannotOperateReason() {
  if (!state.network.ready) {
    return "联机服务未就绪";
  }

  if (!state.network.roomId || !state.network.room) {
    return "请先创建房间或通过链接加入房间";
  }

  if (state.network.role === "spectator") {
    return "观战模式不可操作";
  }

  const roomStatus = getEffectiveRoomStatus();
  if (roomStatus === "waiting") {
    return "等待另一位玩家加入";
  }

  if (roomStatus === "finished" || state.game.gameOver) {
    return "游戏已结束";
  }

  if (!canClientUseColor(getCurrentTurnColor())) {
    return `当前轮到${COLOR_LABEL[getCurrentTurnColor()]}色，请等待对手`;
  }

  return "";
}

function canCurrentClientOperate() {
  return getCannotOperateReason() === "";
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

  state.game.pieces.forEach((piece) => {
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
    const sectionGrid = state.dom.pieceSectionGrids.get(piece.color);
    if (sectionGrid) {
      sectionGrid.appendChild(card);
    }
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
  TURN_ORDER.forEach((color) => {
    const section = state.dom.pieceSections.get(color);
    if (!section) {
      return;
    }

    const isActive = color === getCurrentTurnColor();
    section.classList.toggle("is-active", isActive);
    section.classList.toggle("is-inactive", !isActive);
  });

  state.game.pieces.forEach((piece) => {
    const card = state.dom.pieceCards.get(piece.pieceId);
    if (!card) {
      return;
    }

    const isSelected = state.selectedPieceId === piece.pieceId;
    const canSelectThisPiece =
      !piece.used &&
      canCurrentClientOperate() &&
      canClientUseColor(piece.color) &&
      canUseColorThisTurn(piece.color);

    const isTurnLocked = !piece.used && !canSelectThisPiece;

    card.classList.toggle("is-selected", isSelected);
    card.classList.toggle("is-used", piece.used);
    card.classList.toggle("is-turn-locked", isTurnLocked);
    card.setAttribute("aria-disabled", piece.used || isTurnLocked ? "true" : "false");
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

function renderFloatingPreview() {
  const floating = state.dom.floatingPiece;
  const floatingGrid = state.dom.floatingPieceGrid;
  if (!floating || !floatingGrid) {
    return;
  }

  if (!state.selectedPieceId || state.game.gameOver) {
    floating.classList.remove("is-visible");
    floatingGrid.innerHTML = "";
    return;
  }

  const selectedPiece = getPieceById(state.selectedPieceId);
  if (!selectedPiece) {
    floating.classList.remove("is-visible");
    floatingGrid.innerHTML = "";
    return;
  }

  const transformed = getTransformedShape(
    selectedPiece.shape,
    state.selectedRotation,
    state.selectedFlipped
  );

  drawMiniShapeFromPoints(floatingGrid, transformed, selectedPiece.color);
  floating.classList.add("is-visible");
}

function isInBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
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
}

function renderBoard() {
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
      }
    }
  }

  renderPreview();
}

function getResultText(scores) {
  if (!state.game.gameOver) {
    return "对局进行中";
  }

  if (scores.winner === "player1") {
    return `游戏结束：玩家1获胜（${scores.player1Placed} : ${scores.player2Placed}）`;
  }

  if (scores.winner === "player2") {
    return `游戏结束：玩家2获胜（${scores.player2Placed} : ${scores.player1Placed}）`;
  }

  return `游戏结束：平局（${scores.player1Placed} : ${scores.player2Placed}）`;
}

function updateRoomCardUI() {
  const room = state.network.room;
  const roomId = state.network.roomId;
  const roomStatus = getEffectiveRoomStatus();
  const role = state.network.role;
  const canAct = canCurrentClientOperate();

  if (!roomId || !room) {
    state.dom.ui.roomCode.textContent = "房间号：未加入";
    state.dom.ui.roomRole.textContent = `我的身份：${ROLE_LABEL.none}`;
    state.dom.ui.roomStatus.textContent = "房间状态：未连接";
    state.dom.ui.roomCanAct.textContent = "当前是否轮到我：否";

    if (!state.network.ready) {
      state.dom.ui.roomHint.textContent = "联机服务未就绪，可点击“创建房间”重试";
    } else {
      state.dom.ui.roomHint.textContent = "无 room 参数时请先创建房间";
    }

    state.dom.buttons.createRoom.disabled = state.network.creatingRoom;
    state.dom.buttons.copyRoomLink.disabled = true;
    return;
  }

  state.dom.ui.roomCode.textContent = `房间号：${room.id}`;
  state.dom.ui.roomRole.textContent = `我的身份：${ROLE_LABEL[role] || ROLE_LABEL.none}`;
  state.dom.ui.roomStatus.textContent = `房间状态：${ROOM_STATUS_LABEL[roomStatus] || roomStatus}`;
  state.dom.ui.roomCanAct.textContent = `当前是否轮到我：${canAct ? "是" : "否"}`;

  if (roomStatus === "waiting") {
    if (role === "host") {
      state.dom.ui.roomHint.textContent = "等待玩家2通过链接加入";
    } else if (role === "guest") {
      state.dom.ui.roomHint.textContent = "已加入房间，等待房间进入对局状态";
    } else {
      state.dom.ui.roomHint.textContent = "该房间正在等待玩家加入";
    }
  } else if (roomStatus === "playing") {
    if (canAct) {
      state.dom.ui.roomHint.textContent = `轮到你操作（${COLOR_LABEL[getCurrentTurnColor()]}色）`;
    } else {
      state.dom.ui.roomHint.textContent = `等待${COLOR_LABEL[getCurrentTurnColor()]}色玩家操作`;
    }
  } else {
    state.dom.ui.roomHint.textContent = "对局已结束，可复制链接查看结果";
  }

  state.dom.buttons.createRoom.disabled = true;
  state.dom.buttons.copyRoomLink.disabled = false;
}

function updateTurnUI() {
  const turnColor = getCurrentTurnColor();
  const turnPlayer = getPlayerByColor(turnColor);
  const scores = state.game.scores || calculateScores(state.game);

  state.dom.ui.turnPlayer.textContent = `${PLAYER_CONFIG[turnPlayer].name}（${COLOR_LABEL[turnColor]}色）`;
  state.dom.ui.turnNumber.textContent = `第 ${state.game.turnCount} 手`;
  state.dom.ui.turnColors.textContent = `当前颜色：${COLOR_LABEL[turnColor]}`;

  if (state.selectedPieceId) {
    const selectedPiece = getPieceById(state.selectedPieceId);
    if (selectedPiece) {
      state.dom.ui.selectedPiece.textContent = `拼块：${selectedPiece.shape}`;
      state.dom.ui.selectedColor.textContent = `颜色：${COLOR_LABEL[selectedPiece.color]}`;
      state.dom.ui.selectedRotation.textContent = `旋转：${state.selectedRotation}°`;
      state.dom.ui.selectedFlip.textContent = `翻转：${state.selectedFlipped ? "是" : "否"}`;
    }
  } else {
    state.dom.ui.selectedPiece.textContent = "拼块：无";
    state.dom.ui.selectedColor.textContent = "颜色：无";
    state.dom.ui.selectedRotation.textContent = "旋转：0°";
    state.dom.ui.selectedFlip.textContent = "翻转：否";
  }

  state.dom.ui.statusText.textContent = state.message;

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

  state.dom.ui.player1Placed.textContent = `玩家1得分：${scores.player1Placed}`;
  state.dom.ui.player1Remain.textContent = `玩家1剩余格：${scores.player1Remain}`;
  state.dom.ui.player2Placed.textContent = `玩家2得分：${scores.player2Placed}`;
  state.dom.ui.player2Remain.textContent = `玩家2剩余格：${scores.player2Remain}`;

  state.dom.ui.resultText.textContent = getResultText(scores);
  state.dom.ui.resultCard.classList.toggle("is-finished", state.game.gameOver);

  updateRoomCardUI();
}

function renderControls() {
  const hasSelected = Boolean(state.selectedPieceId);
  const canOperate = hasSelected && canCurrentClientOperate() && !state.network.syncingMove;
  const canPlace = canOperate && Boolean(state.preview?.valid);

  state.dom.buttons.rotate.disabled = !canOperate;
  state.dom.buttons.flip.disabled = !canOperate;
  state.dom.buttons.place.disabled = !canPlace;
  state.dom.buttons.place.classList.toggle("is-ready", canPlace);
  state.dom.buttons.cancel.disabled = state.game.gameOver || (!hasSelected && !state.preview);
}

function render() {
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
    state.message = "游戏已结束";
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
    state.message = "该拼块已使用";
    render();
    return;
  }

  if (!canUseColorThisTurn(piece.color)) {
    state.message = `当前回合只能操作${COLOR_LABEL[getCurrentTurnColor()]}色拼块`;
    render();
    return;
  }

  if (!canClientUseColor(piece.color)) {
    state.message = "该颜色不属于你的可操作范围";
    render();
    return;
  }

  if (state.selectedPieceId === piece.pieceId) {
    state.message = `已持有 ${COLOR_LABEL[piece.color]}-${piece.shape}`;
    render();
    return;
  }

  state.selectedPieceId = piece.pieceId;
  state.selectedRotation = 0;
  state.selectedFlipped = false;
  state.previewAnchor = null;
  state.preview = null;
  state.message = `已选择 ${COLOR_LABEL[piece.color]}-${piece.shape}，请在棋盘上滑动设置预览`;
  render();
}

function refreshPreviewForCurrentAnchor(successMessage) {
  if (!state.previewAnchor) {
    state.message = successMessage;
    render();
    return;
  }

  const move = buildMove(state.previewAnchor.row, state.previewAnchor.col);
  state.preview = buildPreview(move);
  state.message = state.preview?.valid ? "预览合法，可放置" : `非法预览：${state.preview?.reason || "未知原因"}`;
  render();
}

function rotateSelectedPiece() {
  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "请先选择拼块";
    render();
    return;
  }

  state.selectedRotation = (state.selectedRotation + 90) % 360;
  refreshPreviewForCurrentAnchor(`已旋转到 ${state.selectedRotation}°`);
}

function flipSelectedPiece() {
  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "请先选择拼块";
    render();
    return;
  }

  state.selectedFlipped = !state.selectedFlipped;
  refreshPreviewForCurrentAnchor(`已${state.selectedFlipped ? "启用" : "取消"}水平翻转`);
}

function updatePreviewAt(row, col) {
  if (!state.selectedPieceId) {
    state.message = "请先选择拼块";
    render();
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  const move = buildMove(row, col);
  state.previewAnchor = { row, col };
  state.preview = buildPreview(move);
  state.message = state.preview?.valid ? "预览合法，可放置" : `非法预览：${state.preview?.reason || "未知原因"}`;
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
  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "请先选择拼块";
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
  event.preventDefault();
}

function handleBoardPointerMove(event) {
  if (!state.boardPointer.active || state.boardPointer.pointerId !== event.pointerId) {
    return;
  }

  updatePreviewFromPointer(event);
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
}

function buildPlaceSuccessMessage(result, move) {
  const placedColor = result.placedColor;
  const skipped = result.skippedColors || [];

  let text = `${getPlayerNameByColor(placedColor)}放置${COLOR_LABEL[placedColor]}色拼块成功`;
  if (skipped.length) {
    text += `，${skipped.map((color) => `${COLOR_LABEL[color]}色`).join("、")}无合法步已自动跳过`;
  }

  if (result.state.gameOver) {
    text += "。四种颜色均无合法落子，游戏结束";
  } else {
    text += `，轮到${COLOR_LABEL[result.state.currentTurnColor]}色（${getPlayerNameByColor(result.state.currentTurnColor)}）`;
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
    message: message || "已从服务器同步最新状态",
    fromRealtime: false,
  });
}

async function placePiece() {
  if (state.network.syncingMove) {
    return;
  }

  const blockReason = getCannotOperateReason();
  if (blockReason) {
    state.message = blockReason;
    render();
    return;
  }

  if (!state.selectedPieceId) {
    state.message = "请先选择拼块";
    render();
    return;
  }

  if (!state.preview) {
    state.message = "请先在棋盘上滑动设置预览位置";
    render();
    return;
  }

  if (!state.preview.valid) {
    state.message = `放置失败：${state.preview.reason}`;
    render();
    return;
  }

  const localResult = applyMove(state.game, state.preview.move);
  if (!localResult.ok) {
    state.message = `放置失败：${localResult.reason}`;
    render();
    return;
  }

  const moveSnapshot = { ...state.preview.move };
  const message = buildPlaceSuccessMessage(localResult, moveSnapshot);

  state.network.syncingMove = true;
  render();

  try {
    const payload = {
      game_state: serializeGameState(localResult.state),
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
        // moves 表仅做日志，不影响主流程
        console.warn("记录 moves 日志失败:", error);
      });
    }
  } catch (error) {
    try {
      await syncRoomFromServer("房间已有新变更，已自动同步最新状态");
    } catch (_syncError) {
      state.message = `放置失败：${error.message || String(error)}`;
      render();
    }
  } finally {
    state.network.syncingMove = false;
    render();
  }
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

function updateLayout() {
  const root = document.documentElement;
  const app = document.getElementById("app");
  const shell = document.querySelector(".main-shell");
  const controls = document.querySelector(".control-panel");

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  document.body.classList.toggle("portrait", viewportW < viewportH);

  if (!app || !shell || !controls) {
    return;
  }

  const appStyles = window.getComputedStyle(app);
  const shellStyles = window.getComputedStyle(shell);

  const appPadX = parseFloat(appStyles.paddingLeft) + parseFloat(appStyles.paddingRight);
  const appPadY = parseFloat(appStyles.paddingTop) + parseFloat(appStyles.paddingBottom);
  const rowGap = parseFloat(appStyles.rowGap);

  const shellPadY = parseFloat(shellStyles.paddingTop || 0) + parseFloat(shellStyles.paddingBottom || 0);
  const columnGap = parseFloat(shellStyles.columnGap);

  const controlsH = controls.getBoundingClientRect().height;
  const sideMin = parseFloat(window.getComputedStyle(root).getPropertyValue("--side-min") || "84");

  const maxByHeight = viewportH - appPadY - rowGap - controlsH - shellPadY;
  const maxByWidth = viewportW - appPadX - 2 * sideMin - 2 * columnGap;

  const boardSize = Math.max(220, Math.floor(Math.min(maxByHeight, maxByWidth)));
  root.style.setProperty("--board-size", `${boardSize}px`);
}

function buildRealtimeSyncMessage(room) {
  const status = room.status || "waiting";
  if (status === "finished" || state.game.gameOver) {
    return "房间状态已同步：对局已结束";
  }

  if (status === "waiting") {
    return "房间状态已同步：等待玩家加入";
  }

  if (canCurrentClientOperate()) {
    return `房间状态已同步：轮到你操作（${COLOR_LABEL[getCurrentTurnColor()]}色）`;
  }

  return `房间状态已同步：等待${COLOR_LABEL[getCurrentTurnColor()]}色玩家`;
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
  state.network.role = getRoleByRoom(room, state.network.userId);

  try {
    state.game = deserializeGameState(room.game_state);
  } catch (_error) {
    state.game = createInitialGameState();
  }

  clearTransientSelection();
  state.lastScrolledTurnColor = null;

  if (typeof options.message === "string") {
    state.message = options.message;
  } else if (options.fromRealtime) {
    state.message = buildRealtimeSyncMessage(room);
  }

  render();
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

async function createOnlineRoom() {
  if (state.network.creatingRoom) {
    return;
  }

  if (!(await ensureNetworkReady())) {
    return;
  }

  if (state.network.roomId) {
    state.message = "当前已在房间中，若要新开房请使用新页面";
    render();
    return;
  }

  state.network.creatingRoom = true;
  render();

  try {
    const initialGame = createInitialGameState();
    const room = await sbCreateRoom(state.network.client, {
      hostUserId: state.network.userId,
      status: "waiting",
      currentTurnColor: initialGame.currentTurnColor,
      gameState: serializeGameState(initialGame),
      winner: null,
    });

    setRoomIdToUrl(room.id);
    subscribeCurrentRoom(room.id);
    applyRoomSnapshot(room, {
      message: `房间 ${room.id} 创建成功，等待玩家2加入`,
      fromRealtime: false,
    });
  } catch (error) {
    state.message = `创建房间失败：${error.message || String(error)}`;
    render();
  } finally {
    state.network.creatingRoom = false;
    render();
  }
}

async function joinOrLoadRoomByUrl() {
  const roomId = getRoomIdFromUrl();
  if (!roomId) {
    render();
    return;
  }

  if (!(await ensureNetworkReady())) {
    return;
  }

  state.network.initializing = true;
  render();

  try {
    const room = await sbJoinRoom(state.network.client, roomId, state.network.userId);
    setRoomIdToUrl(room.id);
    subscribeCurrentRoom(room.id);
    applyRoomSnapshot(room, {
      message: `已进入房间 ${room.id}`,
      fromRealtime: false,
    });
  } catch (error) {
    state.message = `加入房间失败：${error.message || String(error)}`;
    render();
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
  state.dom.buttons.cancel.addEventListener("click", () => {
    clearSelection("已取消当前选择");
  });
  state.dom.buttons.createRoom.addEventListener("click", createOnlineRoom);
  state.dom.buttons.copyRoomLink.addEventListener("click", copyRoomLink);

  window.addEventListener("resize", updateLayout);
  window.addEventListener("orientationchange", updateLayout);
}

function cacheDom() {
  state.dom.board = document.getElementById("board");
  state.dom.piecePool = document.getElementById("piecePool");
  state.dom.floatingPiece = document.getElementById("floatingPiece");
  state.dom.floatingPieceGrid = document.getElementById("floatingPieceGrid");

  state.dom.buttons = {
    rotate: document.getElementById("btnRotate"),
    flip: document.getElementById("btnFlip"),
    place: document.getElementById("btnPlace"),
    cancel: document.getElementById("btnCancel"),
    createRoom: document.getElementById("btnCreateRoom"),
    copyRoomLink: document.getElementById("btnCopyRoomLink"),
  };

  state.dom.ui = {
    turnPlayer: document.getElementById("turnPlayer"),
    turnNumber: document.getElementById("turnNumber"),
    turnColors: document.getElementById("turnColors"),
    selectedPiece: document.getElementById("selectedPiece"),
    selectedColor: document.getElementById("selectedColor"),
    selectedRotation: document.getElementById("selectedRotation"),
    selectedFlip: document.getElementById("selectedFlip"),
    statusText: document.getElementById("statusText"),
    resultCard: document.getElementById("resultCard"),
    resultText: document.getElementById("resultText"),
    player1Placed: document.getElementById("player1Placed"),
    player1Remain: document.getElementById("player1Remain"),
    player2Placed: document.getElementById("player2Placed"),
    player2Remain: document.getElementById("player2Remain"),
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
    roomRole: document.getElementById("roomRole"),
    roomStatus: document.getElementById("roomStatus"),
    roomCanAct: document.getElementById("roomCanAct"),
    roomHint: document.getElementById("roomHint"),
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
  updateLayout();
  render();

  await joinOrLoadRoomByUrl();
  if (!state.network.roomId) {
    await ensureNetworkReady();
  }
}

init();

window.addEventListener("beforeunload", () => {
  clearRoomSubscription();
});

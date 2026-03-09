(() => {
  const BOARD_SIZE = 20;

  const SHAPES = {
    I1: [[0, 0]],
    I2: [
      [0, 0],
      [1, 0],
    ],
    I3: [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
    V3: [
      [0, 0],
      [0, 1],
      [1, 1],
    ],
    I4: [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ],
    O4: [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    T4: [
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
    ],
    L4: [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 2],
    ],
    Z4: [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
    ],
    F5: [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [1, 2],
    ],
    I5: [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ],
    L5: [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 3],
    ],
    P5: [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 2],
    ],
    N5: [
      [0, 0],
      [1, 0],
      [1, 1],
      [2, 1],
      [3, 1],
    ],
    T5: [
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
      [1, 2],
    ],
    U5: [
      [0, 1],
      [0, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ],
    V5: [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ],
    W5: [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
    X5: [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [1, 2],
    ],
    Y5: [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 1],
    ],
    Z5: [
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 2],
      [2, 2],
    ],
  };

  const SHAPE_ORDER = [
    "I1",
    "I2",
    "I3",
    "V3",
    "I4",
    "O4",
    "T4",
    "L4",
    "Z4",
    "F5",
    "I5",
    "L5",
    "P5",
    "N5",
    "T5",
    "U5",
    "V5",
    "W5",
    "X5",
    "Y5",
    "Z5",
  ];

  const COLOR_ORDER = ["blue", "yellow", "red", "green"];
  const TURN_ORDER = ["blue", "red", "yellow", "green"];

  const COLOR_LABEL = {
    blue: "蓝",
    yellow: "黄",
    red: "红",
    green: "绿",
  };

  const PLAYER_BY_COLOR = {
    blue: 1,
    yellow: 1,
    red: 2,
    green: 2,
  };

  const PLAYER_CONFIG = {
    1: {
      name: "玩家1",
      colors: ["blue", "yellow"],
    },
    2: {
      name: "玩家2",
      colors: ["red", "green"],
    },
  };

  const CORNER_BY_COLOR = {
    blue: { row: 0, col: 0 },
    yellow: { row: 0, col: BOARD_SIZE - 1 },
    red: { row: BOARD_SIZE - 1, col: BOARD_SIZE - 1 },
    green: { row: BOARD_SIZE - 1, col: 0 },
  };

  const ORTHOGONAL_DIRS = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  const DIAGONAL_DIRS = [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];

  const TOTAL_SHAPE_CELLS = SHAPE_ORDER.reduce((sum, shapeName) => sum + SHAPES[shapeName].length, 0);
  const TOTAL_CELLS_BY_COLOR = Object.fromEntries(
    COLOR_ORDER.map((color) => [color, TOTAL_SHAPE_CELLS])
  );

  function createEmptyBoard() {
    return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  function createPieceSet() {
    const pieces = [];

    COLOR_ORDER.forEach((color) => {
      SHAPE_ORDER.forEach((shape) => {
        pieces.push({
          pieceId: `${color}-${shape}`,
          color,
          shape,
          used: false,
        });
      });
    });

    return pieces;
  }

  function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
  }

  function isInBounds(row, col) {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
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

  function getTransformedShape(shapeName, rotation, flipped) {
    const source = SHAPES[shapeName] || [];
    let points = source.map(([x, y]) => [x, y]);

    if (flipped) {
      points = points.map(([x, y]) => [-x, y]);
    }

    const normalizedRotation = ((rotation % 360) + 360) % 360;
    const turnCount = normalizedRotation / 90;

    for (let i = 0; i < turnCount; i += 1) {
      points = points.map(([x, y]) => [y, -x]);
    }

    return normalizePoints(points);
  }

  function getPieceById(state, pieceId) {
    return state.pieces.find((piece) => piece.pieceId === pieceId) || null;
  }

  function getPreviewCells(state, move) {
    if (!move || typeof move.pieceId !== "string") {
      return [];
    }

    const piece = getPieceById(state, move.pieceId);
    if (!piece) {
      return [];
    }

    const anchorRow = Number(move.anchorRow);
    const anchorCol = Number(move.anchorCol);

    if (!Number.isInteger(anchorRow) || !Number.isInteger(anchorCol)) {
      return [];
    }

    const transformed = getTransformedShape(piece.shape, Number(move.rotation) || 0, Boolean(move.flipped));

    return transformed.map(([x, y]) => ({
      row: anchorRow + y,
      col: anchorCol + x,
    }));
  }

  function checkCornerStartRule(state, color, cells) {
    if (state.firstMoveDoneByColor[color]) {
      return { valid: true, reason: "" };
    }

    const corner = CORNER_BY_COLOR[color];
    const containsCorner = cells.some((cell) => cell.row === corner.row && cell.col === corner.col);

    if (!containsCorner) {
      return {
        valid: false,
        reason: `${COLOR_LABEL[color]}色首步必须覆盖对应角落`,
      };
    }

    return { valid: true, reason: "" };
  }

  function checkSameColorEdgeContact(state, color, cells) {
    for (const cell of cells) {
      for (const [dr, dc] of ORTHOGONAL_DIRS) {
        const nr = cell.row + dr;
        const nc = cell.col + dc;

        if (!isInBounds(nr, nc)) {
          continue;
        }

        const neighbor = state.boardMatrix[nr][nc];
        if (neighbor && neighbor.color === color) {
          return {
            valid: false,
            reason: `${COLOR_LABEL[color]}色不能与同色边接触`,
          };
        }
      }
    }

    return { valid: true, reason: "" };
  }

  function checkSameColorCornerContact(state, color, cells) {
    if (!state.firstMoveDoneByColor[color]) {
      return { valid: true, reason: "" };
    }

    for (const cell of cells) {
      for (const [dr, dc] of DIAGONAL_DIRS) {
        const nr = cell.row + dr;
        const nc = cell.col + dc;

        if (!isInBounds(nr, nc)) {
          continue;
        }

        const neighbor = state.boardMatrix[nr][nc];
        if (neighbor && neighbor.color === color) {
          return { valid: true, reason: "" };
        }
      }
    }

    return {
      valid: false,
      reason: `${COLOR_LABEL[color]}色后续落子必须与同色角接触`,
    };
  }

  function canPlaceCells(state, color, cells) {
    const inBound = cells.every((cell) => isInBounds(cell.row, cell.col));
    if (!inBound) {
      return { valid: false, reason: "拼块越界" };
    }

    const overlap = cells.some((cell) => state.boardMatrix[cell.row][cell.col] !== null);
    if (overlap) {
      return { valid: false, reason: "与已有方块重叠" };
    }

    const cornerStart = checkCornerStartRule(state, color, cells);
    if (!cornerStart.valid) {
      return cornerStart;
    }

    const sameColorEdge = checkSameColorEdgeContact(state, color, cells);
    if (!sameColorEdge.valid) {
      return sameColorEdge;
    }

    const sameColorCorner = checkSameColorCornerContact(state, color, cells);
    if (!sameColorCorner.valid) {
      return sameColorCorner;
    }

    return { valid: true, reason: "" };
  }

  function canPlaceMove(state, move) {
    if (state.gameOver) {
      return {
        valid: false,
        reason: "游戏已结束",
        cells: [],
      };
    }

    if (!move || typeof move.pieceId !== "string") {
      return {
        valid: false,
        reason: "缺少拼块信息",
        cells: [],
      };
    }

    const piece = getPieceById(state, move.pieceId);
    if (!piece) {
      return {
        valid: false,
        reason: "拼块不存在",
        cells: [],
      };
    }

    if (piece.used) {
      return {
        valid: false,
        reason: "该拼块已使用",
        cells: [],
      };
    }

    if (piece.color !== state.currentTurnColor) {
      return {
        valid: false,
        reason: `当前回合只能操作${COLOR_LABEL[state.currentTurnColor]}色拼块`,
        cells: [],
      };
    }

    const cells = getPreviewCells(state, move);
    if (!cells.length) {
      return {
        valid: false,
        reason: "预览锚点无效",
        cells,
      };
    }

    const check = canPlaceCells(state, piece.color, cells);
    return {
      ...check,
      cells,
      color: piece.color,
      shape: piece.shape,
      pieceId: piece.pieceId,
    };
  }

  function hasAnyLegalMoveForColor(state, color) {
    const candidates = state.pieces.filter((piece) => piece.color === color && !piece.used);
    if (!candidates.length) {
      return false;
    }

    for (const piece of candidates) {
      for (const flipped of [false, true]) {
        for (const rotation of [0, 90, 180, 270]) {
          const transformed = getTransformedShape(piece.shape, rotation, flipped);

          let maxX = 0;
          let maxY = 0;
          transformed.forEach(([x, y]) => {
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          });

          const rowLimit = BOARD_SIZE - 1 - maxY;
          const colLimit = BOARD_SIZE - 1 - maxX;

          for (let row = 0; row <= rowLimit; row += 1) {
            for (let col = 0; col <= colLimit; col += 1) {
              const cells = transformed.map(([x, y]) => ({ row: row + y, col: col + x }));
              if (canPlaceCells(state, color, cells).valid) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  function getNextTurnColor(state) {
    const nextIndex = (state.turnIndex + 1) % state.turnOrder.length;
    return state.turnOrder[nextIndex];
  }

  function stepToNextTurn(state) {
    const nextIndex = (state.turnIndex + 1) % state.turnOrder.length;
    state.turnIndex = nextIndex;
    state.currentTurnColor = state.turnOrder[nextIndex];
    state.turnCount += 1;
  }

  function calculateScores(state) {
    const placedCellsByColor = Object.fromEntries(COLOR_ORDER.map((color) => [color, 0]));

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = state.boardMatrix[row][col];
        if (cell && placedCellsByColor[cell.color] !== undefined) {
          placedCellsByColor[cell.color] += 1;
        }
      }
    }

    const remainingCellsByColor = {};
    COLOR_ORDER.forEach((color) => {
      remainingCellsByColor[color] = TOTAL_CELLS_BY_COLOR[color] - placedCellsByColor[color];
    });

    const remainingPiecesByColor = Object.fromEntries(COLOR_ORDER.map((color) => [color, 0]));
    state.pieces.forEach((piece) => {
      if (!piece.used) {
        remainingPiecesByColor[piece.color] += 1;
      }
    });

    const player1Placed = placedCellsByColor.blue + placedCellsByColor.yellow;
    const player2Placed = placedCellsByColor.red + placedCellsByColor.green;
    const player1Remain = remainingCellsByColor.blue + remainingCellsByColor.yellow;
    const player2Remain = remainingCellsByColor.red + remainingCellsByColor.green;

    let winner = "draw";
    if (player1Placed > player2Placed) {
      winner = "player1";
    } else if (player2Placed > player1Placed) {
      winner = "player2";
    }

    return {
      placedCellsByColor,
      remainingCellsByColor,
      remainingPiecesByColor,
      player1Placed,
      player2Placed,
      player1Remain,
      player2Remain,
      winner,
    };
  }

  function checkGameOver(inputState) {
    const state = cloneState(inputState);

    if (state.consecutivePasses >= state.turnOrder.length) {
      state.gameOver = true;
    }

    state.scores = calculateScores(state);
    state.winner = state.gameOver ? state.scores.winner : null;

    return state;
  }

  function resolveAutoPasses(inputState) {
    let state = cloneState(inputState);
    const skippedColors = [];

    for (let checked = 0; checked < state.turnOrder.length; checked += 1) {
      const color = state.currentTurnColor;
      if (hasAnyLegalMoveForColor(state, color)) {
        state.consecutivePasses = skippedColors.length;
        state = checkGameOver(state);
        return { state, skippedColors };
      }

      skippedColors.push(color);
      state.moveHistory.push({
        type: "pass",
        color,
        turnNumber: state.turnCount,
      });
      stepToNextTurn(state);
    }

    state.consecutivePasses = skippedColors.length;
    state.gameOver = true;
    state = checkGameOver(state);
    return { state, skippedColors };
  }

  function applyMove(inputState, move) {
    const check = canPlaceMove(inputState, move);
    if (!check.valid) {
      return {
        ok: false,
        state: inputState,
        reason: check.reason,
        skippedColors: [],
      };
    }

    let state = cloneState(inputState);
    const piece = getPieceById(state, move.pieceId);
    if (!piece) {
      return {
        ok: false,
        state: inputState,
        reason: "拼块不存在",
        skippedColors: [],
      };
    }

    check.cells.forEach((cell) => {
      state.boardMatrix[cell.row][cell.col] = {
        pieceId: piece.pieceId,
        color: piece.color,
      };
    });

    piece.used = true;
    if (!state.usedPieces.includes(piece.pieceId)) {
      state.usedPieces.push(piece.pieceId);
    }
    state.firstMoveDoneByColor[piece.color] = true;

    state.moveHistory.push({
      type: "place",
      pieceId: piece.pieceId,
      color: piece.color,
      shape: piece.shape,
      rotation: Number(move.rotation) || 0,
      flipped: Boolean(move.flipped),
      anchorRow: Number(move.anchorRow),
      anchorCol: Number(move.anchorCol),
      turnNumber: state.turnCount,
      cells: check.cells.map((cell) => ({ row: cell.row, col: cell.col })),
    });

    state.consecutivePasses = 0;

    stepToNextTurn(state);

    const passResult = resolveAutoPasses(state);
    state = passResult.state;

    return {
      ok: true,
      state,
      skippedColors: passResult.skippedColors,
      placedColor: piece.color,
      pieceId: piece.pieceId,
    };
  }

  function createInitialGameState() {
    const state = {
      boardMatrix: createEmptyBoard(),
      currentTurnColor: TURN_ORDER[0],
      turnOrder: [...TURN_ORDER],
      turnIndex: 0,
      turnCount: 1,
      usedPieces: [],
      firstMoveDoneByColor: {
        blue: false,
        yellow: false,
        red: false,
        green: false,
      },
      gameOver: false,
      winner: null,
      consecutivePasses: 0,
      scores: null,
      moveHistory: [],
      pieces: createPieceSet(),
    };

    return checkGameOver(state);
  }

  function serializeGameState(state) {
    return JSON.stringify(state);
  }

  function normalizeBoardMatrix(rawBoard) {
    const board = createEmptyBoard();

    if (!Array.isArray(rawBoard)) {
      return board;
    }

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      const sourceRow = rawBoard[row];
      if (!Array.isArray(sourceRow)) {
        continue;
      }

      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = sourceRow[col];
        if (
          cell &&
          typeof cell === "object" &&
          typeof cell.pieceId === "string" &&
          typeof cell.color === "string"
        ) {
          board[row][col] = {
            pieceId: cell.pieceId,
            color: cell.color,
          };
        }
      }
    }

    return board;
  }

  function normalizePieces(rawPieces, rawUsedPieces) {
    const basePieces = createPieceSet();
    const usedSet = new Set(Array.isArray(rawUsedPieces) ? rawUsedPieces : []);

    if (!Array.isArray(rawPieces)) {
      return basePieces.map((piece) => ({
        ...piece,
        used: usedSet.has(piece.pieceId),
      }));
    }

    const byId = new Map();
    rawPieces.forEach((piece) => {
      if (!piece || typeof piece !== "object") {
        return;
      }
      if (typeof piece.pieceId !== "string") {
        return;
      }
      byId.set(piece.pieceId, piece);
    });

    return basePieces.map((piece) => {
      const source = byId.get(piece.pieceId);
      return {
        ...piece,
        used: Boolean(source?.used) || usedSet.has(piece.pieceId),
      };
    });
  }

  function normalizeFirstMoveFlags(rawFlags, boardMatrix) {
    const flags = {
      blue: Boolean(rawFlags?.blue),
      yellow: Boolean(rawFlags?.yellow),
      red: Boolean(rawFlags?.red),
      green: Boolean(rawFlags?.green),
    };

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const cell = boardMatrix[row][col];
        if (cell && flags[cell.color] !== undefined) {
          flags[cell.color] = true;
        }
      }
    }

    return flags;
  }

  function deserializeGameState(data) {
    const parsed = typeof data === "string" ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== "object") {
      return createInitialGameState();
    }

    const base = createInitialGameState();

    const turnOrder =
      Array.isArray(parsed.turnOrder) &&
      parsed.turnOrder.length === TURN_ORDER.length &&
      parsed.turnOrder.every((color) => TURN_ORDER.includes(color))
        ? [...parsed.turnOrder]
        : [...base.turnOrder];

    let currentTurnColor =
      typeof parsed.currentTurnColor === "string" && turnOrder.includes(parsed.currentTurnColor)
        ? parsed.currentTurnColor
        : turnOrder[0];

    let turnIndex =
      Number.isInteger(parsed.turnIndex) &&
      parsed.turnIndex >= 0 &&
      parsed.turnIndex < turnOrder.length &&
      turnOrder[parsed.turnIndex] === currentTurnColor
        ? parsed.turnIndex
        : turnOrder.indexOf(currentTurnColor);

    if (turnIndex < 0) {
      turnIndex = 0;
      currentTurnColor = turnOrder[0];
    }

    const boardMatrix = normalizeBoardMatrix(parsed.boardMatrix);
    const pieces = normalizePieces(parsed.pieces, parsed.usedPieces);
    const usedPieces = pieces.filter((piece) => piece.used).map((piece) => piece.pieceId);

    const state = {
      boardMatrix,
      currentTurnColor,
      turnOrder,
      turnIndex,
      turnCount:
        Number.isInteger(parsed.turnCount) && parsed.turnCount >= 1 ? parsed.turnCount : base.turnCount,
      usedPieces,
      firstMoveDoneByColor: normalizeFirstMoveFlags(parsed.firstMoveDoneByColor, boardMatrix),
      gameOver: Boolean(parsed.gameOver),
      winner: null,
      consecutivePasses:
        Number.isInteger(parsed.consecutivePasses) && parsed.consecutivePasses >= 0
          ? Math.min(parsed.consecutivePasses, turnOrder.length)
          : 0,
      scores: null,
      moveHistory: Array.isArray(parsed.moveHistory) ? parsed.moveHistory.map((item) => ({ ...item })) : [],
      pieces,
    };

    return checkGameOver(state);
  }

  window.BlokusEngine = {
    BOARD_SIZE,
    SHAPES,
    SHAPE_ORDER,
    COLOR_ORDER,
    TURN_ORDER,
    COLOR_LABEL,
    PLAYER_BY_COLOR,
    PLAYER_CONFIG,
    TOTAL_SHAPE_CELLS,
    TOTAL_CELLS_BY_COLOR,
    createInitialGameState,
    canPlaceMove,
    applyMove,
    getNextTurnColor,
    resolveAutoPasses,
    checkGameOver,
    calculateScores,
    serializeGameState,
    deserializeGameState,
    getTransformedShape,
    getPreviewCells,
  };
})();

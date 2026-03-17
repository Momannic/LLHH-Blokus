# Blokus Current Operation Logic

This file captures the current web version's actual game operation logic and room flow. It is the source of truth to preserve when rewriting the project in Flutter.

Scope:
- Preserve the behavior described here.
- UI style can change in Flutter.
- Core rules still come from `engine.js`.
- Interaction and room/account flow come from `app.js`.

## 1. Top-Level View Flow

There are three runtime views:
- `lobby`
- `waiting`
- `game`

Current user flow:
1. User opens app.
2. If no local account is logged in, lobby only shows account actions.
3. After account login, lobby shows mode selection plus create/join room.
4. Create room or join room enters `waiting`.
5. All joined players mark ready.
6. Host starts game.
7. All clients switch to `game`.
8. If a user leaves waiting back to lobby, the room context is still retained and can be restored with "return room".

## 2. Account Logic

Account system is the entry point before room actions.

Account fields:
- `account_id`
- `nickname`
- `pin`

Behavior:
- User can create account.
- User can log in with `account_id + pin`.
- After login, account info is persisted in `localStorage`.
- On next visit, account is restored automatically if local storage exists.
- If network is ready, the app tries to validate the stored account with Supabase.

Local storage keys:
- `blokus.currentAccount.v1`
- `blokus.lastRoom.v1`
- `blokus.lobbyMode.v1`

Important seat behavior:
- Room seats are bound to `account_id`, not browser anonymous auth id.
- Rejoining from another browser with the same account should recover the previous seat.
- Anonymous Supabase auth is still used only as transport/session plumbing, not as player identity.

## 3. Room and Waiting Logic

### 3.1 Game modes

Supported modes:
- `2p`
- `4p`

Color ownership:

2-player mode:
- `blue -> player1`
- `yellow -> player1`
- `red -> player2`
- `green -> player2`

4-player mode:
- `blue -> player1`
- `red -> player2`
- `yellow -> player3`
- `green -> player4`

Important:
- Turn order is always color-based, not player-based.
- Turn order is fixed:
  - `blue -> red -> yellow -> green`

### 3.2 Waiting room

After create/join:
- View goes to `waiting`, not directly to board.

Waiting room behavior:
- Shows room code.
- Shows seat list according to mode.
- Shows joined / unjoined seats.
- Shows ready status per joined seat.
- Any joined player can toggle ready.
- Only host (`player1`) can start game.
- Start button is only enabled when:
  - room status is `waiting`
  - all seats required by the mode are occupied
  - all joined players are ready

Room statuses:
- `waiting`
- `playing`
- `finished`

Transition:
- Host clicks start.
- Room status updates to `playing`.
- All subscribed clients enter `game`.

## 4. Room Recovery and Seat Recovery

Room recovery rules:
- Last room code is persisted locally.
- Refresh should attempt to restore:
  - current account
  - last room
  - seat in that room

Join behavior:
1. Load room by room code.
2. Parse `game_state`.
3. Check whether current `account_id` already exists in `playerUserMap`.
4. If yes, restore the same seat.
5. If not and room is still in `waiting`, occupy the first empty seat.
6. If not and no seat is available, user becomes spectator or join fails depending on room state.

Important:
- Seat ownership is stored inside serialized room game config, not inferred from browser session.

## 5. Game State and Turn Model

The game engine state includes at least:
- `boardMatrix`
- `currentTurnColor`
- `turnOrder`
- `turnIndex`
- `turnCount`
- `usedPieces`
- `firstMoveDoneByColor`
- `gameOver`
- `winner`
- `consecutivePasses`
- `scores`
- `moveHistory`
- `pieces`

Initial values:
- board size: `20 x 20`
- first turn color: `blue`
- turn order: `blue, red, yellow, green`
- `turnCount = 1`

## 6. Standard Piece Set

Each color owns a full standard one-sided Blokus set of 21 pieces:
- `I1`
- `I2`
- `I3`
- `V3`
- `I4`
- `O4`
- `T4`
- `L4`
- `Z4`
- `F5`
- `I5`
- `L5`
- `P5`
- `N5`
- `T5`
- `U5`
- `V5`
- `W5`
- `X5`
- `Y5`
- `Z5`

Each piece instance id format:
- `${color}-${shape}`

## 7. In-Game Interaction Logic

## 7.1 Piece pool rules

Piece pool behavior:
- Only current turn color pieces are shown.
- Pieces are ordered from small to large.
- Used pieces are disabled/greyed.
- Selected piece is highlighted.

Selection rules:
- Only current turn color can be selected.
- Only colors controlled by the current local seat can be used.
- Used pieces cannot be selected.
- During pending placement confirmation, selecting another piece is blocked.

When selecting a piece:
- `selectedPieceId` is set.
- `selectedRotation = 0`
- `selectedFlipped = false`
- `previewAnchor = null`
- `preview = null`

## 7.2 Rotate and flip

Buttons:
- rotate
- flip
- reselection/cancel
- place / next turn

Rotate behavior:
- Clockwise `+90`
- Cycle: `0 -> 90 -> 180 -> 270 -> 0`

Flip behavior:
- Horizontal mirror

After rotate or flip:
- If there is already a preview anchor, preview is recalculated immediately.
- Same transformed orientation is reflected in the selected piece mini rendering.

## 7.3 Board preview behavior

Current interaction model is mobile drag-preview, not click-to-place.

Board pointer flow:
1. User selects a piece.
2. User touches board (`pointerdown`).
3. App captures pointer.
4. While moving (`pointermove`), the preview updates continuously.
5. On `pointerup` / `pointercancel`, tracking stops.

Preview source:
- The app finds the board cell under the pointer.
- The touched board cell acts as the anchor.
- The anchor is clamped so the transformed piece never goes out of bounds.

Important clamp rule:
- Overflow is prevented before rule checking.
- So dragging outside board edges should make the piece stick to the border instead of going out.

Preview rendering:
- Valid preview uses piece color with lighter/transparent style.
- Invalid preview uses grey style.
- Anchor cell gets special highlight.
- Start corner markers stay visible on board.
- Magnifier view mirrors the same preview state.

## 7.4 Magnifier logic

There is a local magnifier overlay used during drag.

Behavior:
- Shown only while a piece is selected and board pointer tracking is active.
- Centered around current preview anchor.
- Renders a local `7 x 7` board window.
- Shows:
  - placed cells
  - preview cells
  - anchor highlight
  - corner markers

Magnifier is local-only:
- It is not synchronized online.

## 7.5 Place flow: two-step confirmation

This is important and should be preserved in Flutter.

The current app does not immediately finalize the turn when the user first taps place.

Actual flow:

Stage A: local placement confirmation
- User has a valid preview.
- User taps `place`.
- Piece is not yet committed to engine/network.
- App stores a `pendingPlacement` snapshot.
- Board shows the pending placed cells.
- Primary button changes from `place` to `next turn`.

Stage B: turn finalization
- User taps `next turn`.
- App revalidates the pending move with latest room state.
- If still valid:
  - apply engine move
  - write new game state to room
  - insert move log
  - room turn advances
- If invalid because remote state changed:
  - pending placement is cleared
  - user is informed

Why this matters:
- The player can visually confirm the move before ending the turn.

## 7.6 Reselect / cancel behavior

`cancel` button currently means `reselect`, not undo-history.

Behavior without pending placement:
- Clear selected piece
- Clear preview
- Keep already committed board unchanged

Behavior with pending placement:
- Cancel the pending confirmation
- Restore:
  - selected piece
  - rotation
  - flipped state
  - preview anchor
  - preview
- Keep the same player and same turn
- Do not advance turn

This is not global undo.
It only cancels the not-yet-finalized local pending placement.

## 8. Operation Guards

The local client cannot operate when any of the following is true:
- no logged-in account
- network not ready
- no room joined
- current role is spectator
- room status is `waiting`
- room status is `finished`
- engine `gameOver == true`
- current turn color does not belong to local seat

These guards apply to:
- piece selection
- rotate
- flip
- preview update
- place

## 9. Core Rule Logic To Preserve

The Flutter rewrite should keep using exactly these gameplay rules:

### 9.1 Board
- `20 x 20`

### 9.2 Turn order
- Fixed color turn order:
  - `blue -> red -> yellow -> green`

### 9.3 Placement validity

A move is valid only if:
- piece exists
- piece is unused
- piece color equals `currentTurnColor`
- all cells are within board
- no overlap with occupied cells
- first move of each color covers its assigned corner
- same color cannot edge-touch
- after first move, same color must corner-touch at least one existing same-color cell

Assigned starting corners:
- blue: top-left
- yellow: top-right
- red: bottom-right
- green: bottom-left

### 9.4 Auto-pass

After each successful finalized move:
- Turn advances to next color.
- Engine checks whether that color has any legal move.
- If not, it auto-passes that color.
- Continues checking subsequent colors.

Game over condition:
- if `consecutivePasses >= turnOrder.length`
- meaning all four colors have no legal move

### 9.5 Scoring

Engine score model:
- placed cells per color
- remaining cells per color
- remaining pieces per color

2-player aggregate scoring:
- player1 = blue + yellow
- player2 = red + green

Winner:
- more placed cells wins
- equal score => draw

## 10. Online Sync Rules

The online model is state-sync with final actions, not live gesture sync.

What is synchronized:
- room status
- full serialized game state
- current turn color
- winner
- move logs after finalized move
- ready state
- seat assignment

What is not synchronized:
- current selected piece before final confirmation
- current preview anchor while dragging
- local rotate/flip before commit
- magnifier movement
- transient local pending visuals before room update

Important:
- The room state is the final truth.
- Local preview is only advisory until next-turn confirmation writes the move.

## 11. Flutter Rewrite Guidance

The Flutter version should preserve these interaction semantics:
- same three views: lobby / waiting / game
- same account-first entry
- same room recovery behavior
- same seat binding to `account_id`
- same waiting room ready/start rules
- same color-based turn order
- same mobile board drag preview
- same rotate/flip behavior
- same border clamp behavior
- same two-step placement confirmation:
  - `place`
  - `next turn`
- same `reselect` behavior restoring pending move
- same auto-pass and end-game rules

Recommended separation in Flutter:
- `GameEngine` layer: reuse current rules from `engine.js`
- `Session/Room` layer: account, room, seat, ready, sync
- `GameInteractionController` layer:
  - selected piece
  - selected rotation/flipped
  - preview anchor
  - preview validity
  - pending placement
  - local magnifier state

## 12. Files Used As Source

This document was derived from:
- `engine.js`
- `app.js`

If the web version interaction changes later, this document must be updated before Flutter rewrite work continues.

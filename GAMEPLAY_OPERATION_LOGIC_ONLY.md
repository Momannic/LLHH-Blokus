# Blokus Gameplay Operation Logic Only

This file keeps only the in-game interaction logic that should be reused in the Flutter rewrite.

Excluded on purpose:
- account system
- login flow
- lobby flow
- room/account binding
- waiting-room entry flow

Those parts were experimental and should not be treated as stable source of truth.

This file only describes:
- board rules relevant to play
- in-game interaction flow
- piece operation behavior
- placement confirmation behavior
- turn advance behavior

Source of truth:
- `engine.js`
- in-game parts of `app.js`

## 1. Board and Piece Basics

Board:
- fixed `20 x 20`

Per color:
- one full standard 21-piece one-sided Blokus set

Shapes:
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

## 2. Turn Model

Turn order is fixed by color, not by player:
- `blue -> red -> yellow -> green`

Important:
- The game always advances by color.
- Do not change to player-based alternation.

Initial turn:
- `blue`

Engine state relevant to gameplay:
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

## 3. Piece Selection Logic

Only one piece can be selected at a time.

Selection rules:
- Only an unused piece can be selected.
- Only the current turn color can be selected.
- If a piece is already selected and the same piece is tapped again, selection does not change.
- Selecting a different piece resets its transform state.

When a piece becomes selected:
- `selectedPieceId = pieceId`
- `selectedRotation = 0`
- `selectedFlipped = false`
- `previewAnchor = null`
- `preview = null`

## 4. Rotate and Flip Logic

Available operations:
- rotate
- flip

Rotate:
- clockwise `+90`
- cycle is:
  - `0 -> 90 -> 180 -> 270 -> 0`

Flip:
- horizontal mirror

Transform rules:
- Flip happens on the shape points.
- Rotation happens after flip.
- Final transformed shape is normalized to top-left origin.

If there is already a preview anchor:
- rotate or flip must immediately recalculate preview cells
- preview legality must also update immediately

## 5. Board Preview Interaction

The current gameplay interaction is mobile-first drag preview.

Flow:
1. User selects a piece.
2. User touches the board.
3. The touched board cell is used as preview anchor.
4. While dragging/sliding over the board, preview updates continuously.
5. Releasing touch stops tracking, but current preview can remain for placement.

This is not a drag-and-drop DOM piece.
The piece itself does not move as a widget.
Only the preview shadow updates based on board cell under pointer.

## 6. Anchor Clamp Logic

The preview anchor is clamped before legality check.

Meaning:
- the transformed piece must never visually extend outside the board
- if the user drags outside the board, the piece should stick to the border

Clamp is based on transformed piece bounds:
- `minX`
- `maxX`
- `minY`
- `maxY`

Allowed anchor range:
- `anchorCol >= -minX`
- `anchorCol <= BOARD_SIZE - 1 - maxX`
- `anchorRow >= -minY`
- `anchorRow <= BOARD_SIZE - 1 - maxY`

This must apply to:
- main board preview
- anchor position itself
- magnifier/local zoom preview

Important distinction:
- out-of-bounds should be prevented by clamp
- rule conflicts should still show invalid preview

## 7. Preview States

The preview has two visual states:

Valid preview:
- uses current piece color
- lighter / transparent compared to committed placement

Invalid preview:
- grey preview
- not red

Anchor cell:
- the anchor cell is highlighted separately
- only one anchor cell is highlighted

Corner markers:
- start corner markers remain visible on the board
- if first move for a color is already done, marker becomes hidden or weakened

## 8. Placement Rules To Preserve

Placement validity is checked by engine logic.

A move is valid only if:
- piece exists
- piece is unused
- piece color equals `currentTurnColor`
- all cells are inside board
- no overlap with occupied cells
- first move of that color covers its assigned corner
- same color cannot edge-touch
- after first move, same color must corner-touch at least one existing same-color cell

Assigned starting corners:
- blue: top-left
- yellow: top-right
- red: bottom-right
- green: bottom-left

## 9. Placement Flow: Two-Step Confirmation

This is one of the most important behaviors to preserve.

The turn is not finalized on the first place tap.

There are two stages:

### Stage A: place

When the player taps `place` with a valid preview:
- current move is stored as `pendingPlacement`
- board shows the piece as locally placed
- turn does not advance yet
- game engine state is not yet permanently advanced for the next turn in UI flow
- primary button changes from `place` to `next turn`

Purpose:
- let the player visually confirm the final location before ending the turn

### Stage B: next turn

When the player taps `next turn`:
- pending move is revalidated against latest game state
- if still valid:
  - engine `applyMove(...)` is executed
  - turn advances
  - auto-pass may happen
  - game may end

If move became invalid before confirmation:
- pending placement is cleared
- player is returned to active selection state

## 10. Reselect Behavior

The `cancel` action currently means `reselect`, not undo.

Behavior without pending placement:
- clear selected piece
- clear preview
- keep committed board unchanged

Behavior with pending placement:
- cancel the pending confirmation
- restore:
  - selected piece
  - rotation
  - flipped state
  - preview anchor
  - preview cells
- keep the same turn
- do not switch to next color

This is not a historical undo system.
It only reopens the current unconfirmed move.

## 11. Auto-Pass Logic

After a move is fully finalized:
1. Turn steps to the next color.
2. Engine checks whether that color has any legal move.
3. If not, that color is auto-passed.
4. Continue checking next colors in fixed turn order.

Game ends when:
- `consecutivePasses >= turnOrder.length`
- meaning all four colors have no legal moves

## 12. Scoring and Result Logic

Score model:
- placed cells per color
- remaining cells per color
- remaining pieces per color

Two-player aggregate scoring:
- player1 score = blue + yellow placed cells
- player2 score = red + green placed cells

Winner logic:
- more placed cells wins
- equal placed cells = draw

## 13. In-Game UI Semantics To Preserve

These are interaction semantics, not visual style requirements:

- only one selected piece at a time
- selection resets rotation and flip
- rotate and flip immediately affect preview
- board drag updates preview continuously
- preview anchor is clamped to board
- invalid preview remains visible as grey, not hidden
- anchor cell remains specially highlighted
- first tap on `place` enters pending confirmation state
- second tap on `next turn` actually advances the game
- `reselect` during pending state reopens the move instead of losing it

## 14. Magnifier / Local Zoom

The current web version also has a local board magnifier while dragging.

Behavior:
- shown only during active board pointer tracking with a selected piece
- centered on preview anchor
- renders local board neighborhood
- mirrors:
  - placed cells
  - preview cells
  - anchor highlight
  - corner markers

This is a support feature.
It is part of the current interaction model, but if Flutter uses another equivalent local visibility aid, that is acceptable as long as the core placement interaction remains the same.

## 15. Flutter Rewrite Requirement

When rewriting in Flutter, preserve these exact gameplay semantics:
- same board size
- same fixed color turn order
- same standard 21-piece set
- same select / rotate / flip / drag preview model
- same anchor clamp behavior
- same legality rules
- same two-step placement confirmation
- same reselect behavior for pending placement
- same auto-pass and game-over logic

Use this file as the stable reference for gameplay interaction.
Do not use the old account / lobby / room-auth experiments as rewrite input.

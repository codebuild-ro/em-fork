/* eslint-disable import/prefer-default-export */

/** Defines global keyboard shortcuts and gestures. */
import Emitter from 'emitter20'
import { GestureResponderEvent } from 'react-native'
import { Store } from 'redux'
import { ArrowKey } from './@types/ArrowKey'
import Command from './@types/Command'
import CommandId from './@types/CommandId'
import Direction from './@types/Direction'
import GesturePath from './@types/GesturePath'
import Index from './@types/IndexType'
import Key from './@types/Key'
import State from './@types/State'
import { alertActionCreator as alert } from './actions/alert'
import { commandPaletteActionCreator as commandPalette } from './actions/commandPalette'
import { showLatestCommandsActionCreator as showLatestCommands } from './actions/showLatestCommands'
import { suppressExpansionActionCreator as suppressExpansion } from './actions/suppressExpansion'
import { isMac } from './browser'
import * as commandsObject from './commands/index'
import openGestureCheatsheetCommand from './commands/openGestureCheatsheet'
import { AlertType, COMMAND_PALETTE_TIMEOUT, Settings } from './constants'
import * as selection from './device/selection'
import globals from './globals'
import getUserSetting from './selectors/getUserSetting'
import gestureStore from './stores/gesture'
import { executeCommandWithMulticursor } from './util/executeCommand'
import haptics from './util/haptics'
import keyValueBy from './util/keyValueBy'

export const globalCommands: Command[] = Object.values(commandsObject)

export const commandEmitter = new Emitter()

/* A mapping of key codes to uppercase letters.
 * {
 *   65: 'A',
 *   66: 'B',
 *   67: 'C',
 *   ...
 * }
 */
const letters = keyValueBy(Array(26).fill(0), (n, i) => ({
  [65 + i]: String.fromCharCode(65 + i).toUpperCase(),
}))

/* A mapping of key codes to digits.
 * {
 *   48: '0',
 *   49: '1',
 *   50: '2',
 *   ...
 * }
 */
const digits = keyValueBy(Array(58 - 48).fill(0), (n, i) => ({
  [48 + i]: i.toString(),
}))

/**
 * Hash a keyboard shortcut into a string that can be compared with the result of hashKeyDown.
 * This function only handles a single keyboard shortcut, not arrays.
 */
export const hashCommand = (keyboard: string | Key): string => {
  const key = typeof keyboard === 'string' ? { key: keyboard } : keyboard

  return (key.meta ? 'META_' : '') + (key.alt ? 'ALT_' : '') + (key.shift ? 'SHIFT_' : '') + key.key?.toUpperCase()
}

/** Hash all the properties of a keydown event into a string that can be compared with the result of hashCommand. */
export const hashKeyDown = (e: KeyboardEvent): string =>
  (e.metaKey || e.ctrlKey ? 'META_' : '') +
  (e.altKey ? 'ALT_' : '') +
  (e.shiftKey ? 'SHIFT_' : '') +
  // for some reason, e.key returns 'Dead' in some cases, perhaps because of alternate keyboard settings
  // e.g. alt + meta + n
  // use e.keyCode if available instead
  (letters[e.keyCode] || digits[e.keyCode] || e.key || '').toUpperCase()

const ARROW_KEYS_TO_CHARACTER: Record<ArrowKey, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
}

/** Returns true if key is an arrow key. */
export const isArrowKey = (key: string): key is ArrowKey => {
  return key in ARROW_KEYS_TO_CHARACTER
}

/** Converts a gesture letter or event key of an arrow key to an arrow utf8 character. Defaults to input. */
export const arrowTextToArrowCharacter = (s: ArrowKey) => ARROW_KEYS_TO_CHARACTER[s]

/** Formats a keyboard shortcut to display to the user. */
export const formatKeyboardShortcut = (keyboardOrString: Key | Key[] | string): string => {
  // If it's an array, format only the first shortcut for display
  if (Array.isArray(keyboardOrString)) {
    return formatKeyboardShortcut(keyboardOrString[0])
  }

  const keyboard = typeof keyboardOrString === 'string' ? { key: keyboardOrString } : keyboardOrString

  const text = keyboard.shift && keyboard.key.length === 1 ? keyboard.key.toUpperCase() : keyboard.key
  return (
    (keyboard.meta ? (isMac ? 'Command' : 'Ctrl') + ' + ' : '') +
    (keyboard.alt ? (isMac ? 'Option' : 'Alt') + ' + ' : '') +
    (keyboard.control ? 'Control + ' : '') +
    (keyboard.shift ? 'Shift + ' : '') +
    (isArrowKey(text) ? arrowTextToArrowCharacter(text) : text)
  )
}

/** Initializes command indices and logs keyboard shortcut conflicts. */
const index = (): {
  commandKeyIndex: Index<Command>
  commandIdIndex: Index<Command>
  commandGestureIndex: Index<Command>
} => {
  // index commands for O(1) lookup by keyboard
  const commandKeyIndex: Index<Command> = keyValueBy(globalCommands, (command, i, accum) => {
    if (!command.keyboard) return null

    // Handle both single keyboard shortcut and arrays of shortcuts
    const keyboardShortcuts = Array.isArray(command.keyboard) ? command.keyboard : [command.keyboard]

    // Process each keyboard shortcut and create entries in the index
    return keyboardShortcuts.reduce((result: Record<string, Command>, keyboardShortcut) => {
      const hash = hashCommand(keyboardShortcut)

      // check if the same shortcut is used by multiple commands
      if (accum[hash]) {
        console.error(
          `"${command.id}" uses the same shortcut as "${accum[hash].id}": ${formatKeyboardShortcut(keyboardShortcut)}`,
        )
      }

      return { ...result, [hash]: command }
    }, {})
  })

  // index command for O(1) lookup by id
  const commandIdIndex: Index<Command> = keyValueBy(globalCommands, command =>
    command.id ? { [command.id]: command } : null,
  )

  // index command for O(1) lookup by gesture
  const commandGestureIndex: Index<Command> = keyValueBy(globalCommands, command =>
    command.gesture
      ? {
          // command.gesture may be a string or array of strings
          // normalize intro array of strings
          ...keyValueBy(Array.prototype.concat([], command.gesture), gesture => ({
            [gesture]: command,
          })),
        }
      : null,
  )

  return {
    commandKeyIndex,
    commandIdIndex,
    commandGestureIndex,
  }
}

let commandPaletteGesture: number | undefined

const { commandKeyIndex, commandIdIndex, commandGestureIndex } = index()

/** Gets the canonical gesture of the command as a string, ignoring aliases. Returns an empty string if the command does not have a gesture. */
export const gestureString = (command: Command): string =>
  (typeof command.gesture === 'string' ? command.gesture : command.gesture?.[0] || '') as string

/** Get a command by its id. Only use this for dynamic ids that are only known at runtime. If you know the id of the command at compile time, use a static import. */
export const commandById = (id: CommandId): Command => commandIdIndex[id]

/**
 * Keyboard and gesture handlers factory function that binds the store to event handlers.
 *
 * There are two alert types for gesture hints:
 * - GestureHint - The basic gesture hint that is shown immediately on swipe.
 * - CommandPaletteGesture - The command palette that shows all possible gestures from the current sequence after a delay.
 *
 * Gesture Alert System:
 * - handleGestureSegment: Shows basic gesture hints during gesture progress (training mode only)
 * - handleGestureEnd: Shows command palette after gesture completion (training mode only)
 * - handleGestureCancel: Clears all alerts when gesture is cancelled.
 *
 * User Experience Flow:
 * 1. User starts gesture → No feedback
 * 2. User performs swipes → Basic gesture hints show (training mode)
 * 3. User completes gesture → Command palette appears (training mode)
 * 4. Experience mode → No alerts, clean execution.
 *
 * This system ensures command palette only appears after gesture completion,
 * not during gesture progress, providing a cleaner user experience.
 *
 * There is no automated test coverage since timers are so messed up in the current Jest version. It may be possible to write tests if Jest is upgraded. Manual test cases.
 * - Basic gesture hint appears during gesture progress (training mode only).
 * - Command palette appears after gesture completion (training mode only).
 * - Gesture hint preserved for valid commands (except back/forward).
 * - Gesture hint dismissed for invalid commands or back/forward gestures.
 * - Command palette shown after gesture completion with delay.
 * - Command palette cleared when gesture cancelled.
 * - Haptic feedback on valid gesture segments.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inputHandlers = (store: Store<State, any>) => ({
  /**
   * Handles basic gesture hints during gesture progress (training mode only).
   *
   * This function shows immediate feedback during gesture execution but does NOT
   * show the command palette during gesture progress. The command palette is
   * handled separately in handleGestureEnd to ensure it only appears after
   * gesture completion.
   */
  handleGestureSegment: ({ sequence }: { gesture: Direction | null; sequence: GesturePath }) => {
    const state = store.getState()
    const experienceMode = getUserSetting(state, Settings.experienceMode)

    if (state.showModal || state.dragInProgress || state.showGestureCheatsheet) return

    // Stop gesture segment haptics when there are no more possible commands that can be completed from the current sequence.
    // useFilteredCommands updates the possibleCommands in a back channel for efficiency.
    // Always allow haptics for the first swipe, as possibleCommands may not be populated yet.
    if (sequence.length === 1 || gestureStore.getState().possibleCommands.length > 2) {
      haptics.light()
    }

    const command = commandGestureIndex[sequence as string]

    // Show basic gesture hint during gesture progress (training mode only)
    // Note: Command palette is NOT shown here - it's handled in handleGestureEnd
    if (
      !experienceMode &&
      // only show basic gesture hint if the command palette is not already being shown
      !state.showCommandPalette &&
      // ignore back/forward gestures
      command?.id !== 'cursorBack' &&
      command?.id !== 'cursorForward' &&
      // only show for valid commands or existing gesture hints
      (command || state.alert?.alertType === AlertType.GestureHint)
    ) {
      store.dispatch(
        // Show basic gesture hint with command label
        alert(command && command?.label, {
          alertType: AlertType.GestureHint,
          clearDelay: 5000,
          showCloseLink: false,
        }),
      )
    }
  },

  /**
   * Executes a valid gesture and shows command palette after completion (training mode only).
   *
   * This function handles gesture completion and ensures the command palette only
   * appears after the gesture is finished, not during gesture progress. This
   * provides a cleaner user experience where users see available commands when
   * they're done gesturing, not while they're still in the middle of it.
   */
  handleGestureEnd: ({ sequence, e }: { sequence: GesturePath | null; e: GestureResponderEvent }) => {
    const state = store.getState()

    // Get the command from the command gesture index.
    // When the command palette is displayed, disable gesture aliases (i.e. gestures hidden from instructions).
    // This is because the gesture hints are meant only as an aid when entering gestures quickly.

    const openGestureCheatsheetGesture = gestureString(openGestureCheatsheetCommand)

    // If sequence ends with help gesture, use help command
    // Otherwise use the normal command lookup
    const command = sequence?.toString().endsWith(openGestureCheatsheetGesture)
      ? openGestureCheatsheetCommand
      : !state.showCommandPalette || !commandGestureIndex[sequence as string]?.hideFromHelp
        ? commandGestureIndex[sequence as string]
        : null

    // execute command
    // do not execute when modal is displayed or a drag is in progress
    if (command && !state.showModal && !state.showGestureCheatsheet && !state.dragInProgress) {
      commandEmitter.trigger('command', command)
      executeCommandWithMulticursor(command, { event: e, type: 'gesture', store })
      if (store.getState().enableLatestCommandsDiagram) store.dispatch(showLatestCommands(command))
    }

    const experienceMode = getUserSetting(state, Settings.experienceMode)

    // Show command palette after gesture completion (training mode only)
    // This ensures command palette appears when user is done gesturing, not during
    if (
      !experienceMode &&
      // ignore back/forward gestures
      command?.id !== 'cursorBack' &&
      command?.id !== 'cursorForward'
    ) {
      // Clear any existing command palette timer
      clearTimeout(commandPaletteGesture)
      commandPaletteGesture = undefined

      // Show command palette immediately after gesture completion
      store.dispatch((dispatch, getState) => {
        const state = getState()
        if (state.showCommandPalette) return
        dispatch(commandPalette())
      })

      // Set up delayed command palette display
      commandPaletteGesture = window.setTimeout(() => {
        store.dispatch((dispatch, getState) => {
          const state = getState()
          if (!state.showCommandPalette) return
          dispatch(commandPalette())
        })
      }, COMMAND_PALETTE_TIMEOUT)
    }

    // In experienced mode, close the alert.
    // In training mode, convert CommandPaletteGesture back to GestureHint on gesture end.
    // This needs to be delayed until the next tick otherwise there is a re-render which inadvertantly calls the automatic render focus in the Thought component.
    setTimeout(() => {
      store.dispatch((dispatch, getState) => {
        const state = getState()
        const alertType = state.alert?.alertType
        if (alertType === AlertType.GestureHint) {
          dispatch(
            alert(
              // Keep gesture hint for valid commands (except back/forward)
              // Clear hint for invalid commands or back/forward gestures
              !experienceMode && command && command?.id !== 'cursorForward' && command?.id !== 'cursorBack'
                ? command.label
                : null,
              { alertType: AlertType.GestureHint, clearDelay: 5000 },
            ),
          )
        }
      })
    })
  },

  /** Dismiss gesture hint that is shown by alert. */
  handleGestureCancel: () => {
    clearTimeout(commandPaletteGesture)
    store.dispatch((dispatch, getState) => {
      const state = getState()
      if (state.showCommandPalette) {
        dispatch(commandPalette())
      }
      if (state.alert?.alertType === AlertType.GestureHint || state.showCommandPalette) {
        dispatch(alert(null))
      }
    })
  },

  /** Global keyUp handler. */
  keyUp: (e: KeyboardEvent) => {
    // track meta key for expansion algorithm
    if (e.key === (isMac ? 'Meta' : 'Control') && globals.suppressExpansion) {
      store.dispatch(suppressExpansion(false))
    }
  },

  /** Global keyDown handler. */
  keyDown: (e: KeyboardEvent) => {
    const state = store.getState()

    // track meta key for expansion algorithm
    if (!(isMac ? e.metaKey : e.ctrlKey)) {
      // disable suppress expansion without triggering re-render
      globals.suppressExpansion = false
    }

    // For some reason, when the caret is at the beginning of the thought, alt + ArrowLeft sets the caret to the end.
    // Prevent this default behavior, as the caret should have nowhere to go when it is already at the beginning.
    if (e.altKey && e.key === 'ArrowLeft' && selection.offset() === 0 && selection.isThought()) {
      e.preventDefault()
      return
    }

    // disable if command palette is displayed
    if (state.showCommandPalette) return

    const command = commandKeyIndex[hashKeyDown(e)]

    // disable if modal is shown, except for navigation commands
    if (!command || state.showGestureCheatsheet || (state.showModal && !command.allowExecuteFromModal)) return

    // execute the command
    commandEmitter.trigger('command', command)

    if (!command.canExecute || command.preventDefault || command.canExecute(store.getState())) {
      if (!command.permitDefault) {
        e.preventDefault()
      }

      // execute command
      executeCommandWithMulticursor(command, { event: e, type: 'keyboard', store })
    }
  },
})

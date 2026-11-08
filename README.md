# nfsu2-cheats

`nfsu2-owncar.user.js` (version 1.5.8) is a userscript that adds hotkey toggles for your own car in the browser build of Need for Speed: Underground 2 at [nfsu2.xyz](https://nfsu2.xyz). It changes only the player's own car: hover, a short forward warp, a speed boost, a nitrous refill, extra grip, extra braking, a corner assist and warping to other players. All features work in free roam. In lobby races they stay locked until you allow them with Alt+9, and a tighter race preset then applies.

## Hotkeys

Every hotkey is Alt plus a key (matched by `KeyboardEvent.code`, so the physical key counts, not the layout).

| Keys | Action |
| --- | --- |
| Alt+1 | Hover on or off. The car floats above the ground, and an automatic descent begins before the game's own air-time limit is reached. |
| Alt+2 | Warp the car a short distance forward (200 m by default, with an 8 s cooldown). |
| Alt+3 | Speed boost on or off, up to a speed cap. |
| Alt+4 | Nitrous on or off (the tank is kept full). |
| Alt+5 | Cycle the tyre grip levels 1.6, 2.4 and 3.0, then off. Shift+Alt+5 turns it off. |
| Alt+6 | Cycle the extra braking levels 1.5x, 2.0x and 3.0x, then off. Shift+Alt+6 turns it off. |
| Alt+7 | Corner assist on or off. It raises grip while the wheel is turned and the car slides sideways. |
| Alt+9 | Allow or block the features in lobby races. Blocked is the default, and the setting is not saved across reloads. While it is on, races use the race preset (lower boost cap and shorter warps). |
| Alt+0 | Show or hide the status overlay. |
| Alt+W | Warp behind the selected player. A long jump asks for a second Alt+W within 3 s to confirm. |
| Alt+E | Select the next player. Shift+Alt+E goes back. |
| Alt+Q | Find a player by name. |
| Alt+X / Alt+Z | Hover up / hover down while held. |

All tuning values (speed caps, warp distances, grip and brake levels, hover limits, the key bindings themselves) live in the `CFG` object near the top of the script.

## Install

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open the raw script URL. The manager detects the `.user.js` file and offers to install it.

   ```
   https://raw.githubusercontent.com/onur-tellioglu/nfsu2-cheats/main/nfsu2-owncar.user.js
   ```

3. Open or reload [nfsu2.xyz](https://nfsu2.xyz) and press Alt+0 to see the overlay.

The script runs with `@run-at document-start` because it has to hook the game's WebAssembly memory before the page's own scripts create it. If it is injected later (for example when the manager delays injection, or when you enable it on an already open tab), the overlay reports that no game memory was seen. Reload the page in that case. On Tampermonkey the header's `@sandbox JavaScript` and `@grant unsafeWindow` let it reach the page, and Violentmonkey needs the script injected into the page context (`@inject-into page`).

Besides nfsu2.xyz and its subdomains, the script also matches `localhost` and `127.0.0.1` for a locally hosted copy of the game.

## License

[MIT](LICENSE)

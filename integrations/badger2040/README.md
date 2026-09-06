# Badger2040 companion

Display a compact Flight Recorder summary on a USB-connected Pimoroni Badger2040
or Badger2040 W: run status, agent, event/token counts, latency, estimated cost,
the first recorded alert and a short run ID.

## Device setup

Use current [Pimoroni Badger firmware](https://github.com/pimoroni/badger2040/releases/latest)
with the `badger2040` module and PicoGraphics API. The older firmware with `pen()`
and `font()` methods is not supported. No Wi-Fi configuration is needed.

Back up your existing device files first. Firmware labeled `with-badger-os`
overwrites the device filesystem, and installing this app as `main.py` replaces
the existing startup app. Use Thonny or `mpremote` to put both files in the device
root:

- [flight_badge.py](flight_badge.py)
- [main.py](main.py)

For example, after installing `mpremote` in your own Python environment and
replacing COM5 with the badge's port:

```powershell
mpremote connect COM5 fs cp integrations/badger2040/flight_badge.py :flight_badge.py
mpremote connect COM5 fs cp integrations/badger2040/main.py :main.py
mpremote connect COM5 reset
```

Close Thonny or any other serial console before starting the bridge. The display
shows **WAITING** until a valid summary arrives. Keep USB connected while watching;
the image remains on e-ink after power is removed, but it is no longer live.

## Host bridge

Start the recorder API and create or record a run. From the repository root:

```powershell
npm ci
npm run badger -- --list
npm run badger -- --port COM5 --watch
```

The default server is `http://localhost:5205`. Use `--url` for another HTTPS or
loopback HTTP origin. `--run-id <uuid>` pins a specific run; otherwise the latest
run is used. Omit `--watch` to send one update. Linux/macOS ports typically look
like `/dev/ttyACM0` or `/dev/cu.usbmodem...`; select the actual port shown by
`--list`. Serial access permissions are managed by your operating system.

Polling defaults to 30 seconds, accepts `--interval` values of at least 15 seconds,
and skips unchanged frames. The device also skips duplicate summaries and
periodically performs a normal refresh to reduce ghosting. Ctrl+C stops the host
bridge without clearing the display.

Without hardware, preview the exact wire frame:

```powershell
npm run badger -- --stdout --url http://localhost:5205
npm run test:badger
```

## Protocol and limits

The bridge sends newline-delimited UTF-8 JSON over USB CDC at 115200 baud. Protocol
version 1 permits only `version`, `runId`, `agent`, `status`, `eventCount`, `tokens`,
`durationSeconds`, `estimatedCost` and `alert`. Text is ASCII-normalized and capped
at 28 characters for the agent and 64 for the alert. Frames are limited to 1024
bytes. The display measures text before rendering so long values fit the screen.
Malformed or oversized frames are rejected; reception resumes at the next newline.
The device replies with `OK` or `ERR frame` without echoing trace content.

The bridge never sends prompts, responses, attributes or credentials. Redaction
happens in the recorder, with a second field allowlist in the bridge and receiver.
The badge is physically readable by anyone nearby: even compact metadata may be
sensitive. There is no device-side authorization, storage encryption or proof of
delivery in the host bridge. Unplugging the device does not erase the last image.

Decoder and layout tests run on CPython without the hardware module. They verify
framing, malformed data recovery, allowlisting and measured screen bounds; they do
not replace testing USB reception and e-ink refresh on a physical device.

API references: [Badger2040](https://github.com/pimoroni/badger2040/blob/main/docs/reference.md)
and [PicoGraphics](https://github.com/pimoroni/pimoroni-pico/blob/main/micropython/modules/picographics/README.md).
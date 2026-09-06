import select
import sys

from flight_badge import FrameBuffer, render


def main():
    import badger2040

    display = badger2040.Badger2040()
    display.set_update_speed(badger2040.UPDATE_NORMAL)
    render(display)
    display.update()
    reader = select.poll()
    reader.register(sys.stdin, select.POLLIN)
    frames = FrameBuffer()
    previous = None
    updates = 0
    while True:
        if not reader.poll(250):
            continue
        character = sys.stdin.read(1)
        if not character:
            continue
        try:
            summary = frames.feed(character)
            if summary is None:
                continue
            if summary != previous:
                display.set_update_speed(badger2040.UPDATE_NORMAL if updates % 20 == 0 else badger2040.UPDATE_MEDIUM)
                render(display, summary)
                display.update()
                previous = summary
                updates += 1
            sys.stdout.write("OK\n")
        except (ValueError, TypeError, KeyError):
            sys.stdout.write("ERR frame\n")


if __name__ == "__main__":
    main()
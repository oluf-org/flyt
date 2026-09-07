# Support FAQ — Offline Notes App

Your notes are stored on your device. This app works offline: there is no account and no cloud sync. Every answer below follows from that design.

## 1. How do I move my notes to a new phone?

The app does not sync between devices, so moving notes is a manual three-step process:

1. On your old phone, use **Export** to create a JSON backup of your notes.
2. Transfer that backup file to your new phone using whatever file-transfer method you have available — the app itself does not send files between devices.
3. On your new phone, use **Import** and choose that backup file.

Please read question 5 first: importing **replaces** the notes already on the new phone once you confirm.

## 2. I uninstalled the app and lost my notes. Can I get them back?

Only if you exported them beforehand. Uninstalling deletes the notes stored on the device, and because there is no account and no cloud sync, no other copy exists to restore from.

- If you have a JSON export made before you uninstalled: install the app again and import that file.
- If you do not have an export: the notes cannot be recovered. There is no backup on any server for us to restore from, and we will not promise recovery without an export.

## 3. Can I use the app offline?

Yes — offline use is the whole design. Notes are stored on your device and there is no account and no cloud sync, so you can read and write your notes without an internet connection. The flip side: anything you have not exported exists only on that one device, so export regularly if the notes matter to you.

## 4. Why are my notes not syncing?

Because the app has no sync. There is no account and no cloud sync; notes are stored only on the device you made them on. Nothing is wrong with your device or settings — there is simply no sync feature to turn on. To get notes onto another device, export a JSON backup on this one and import it there. To protect against loss, export regularly; there is no automatic backup.

## 5. Does import merge notes?

No. Import **replaces** the notes already on the device after you confirm — it does not merge or add to them. If the device currently holds notes you want to keep, export them first so you have a JSON backup before importing. Once an import replaces them, the previous notes are gone unless they were exported beforehand.

# Hardware registry v4

La versione 4 separa catalogo dei modelli, istanze fisiche, ruoli e runtime.

- `hardware.json` conserva soltanto l'identita dell'istanza: per Dewin `tuyaDeviceId`; per C410 `ip` e `mac`. Non contiene credenziali.
- `device-roles.json` e l'unica persistenza autorevole per `pump`, `heater`, `pond_temperature` e `pond_camera`.
- Il catalogo supportato fornisce manufacturer, tipo, connessione, protocollo/adapter e capability.

## Migrazione Dewin

Le credenziali del progetto operativo Home Control 24/7, `TUYA_CLIENT_ID_HOME` e `TUYA_CLIENT_SECRET_HOME`, e l'eventuale `TUYA_BASE_URL` restano in `.env`. Le variabili `TUYA_CLIENT_ID_POND` e `TUYA_CLIENT_SECRET_POND` sono esclusivamente riferimenti legacy e non vengono usate dal runtime Dewin.
Se un record legacy `dewin-pond` non contiene `tuyaDeviceId`, all'avvio viene letto il valore non segreto `TUYA_DEWIN_ID` da `.env`. Un valore gia presente nel registry non viene mai sovrascritto. Alla prima mutazione successiva il registry viene scritto in formato v4; `TUYA_DEWIN_ID` puo quindi essere rimosso da `.env` dopo aver verificato il valore in Settings.

I ruoli legacy presenti in `hardware.json` vengono importati nel role store prima che il registry v4 venga persistito. La lettura della vecchia configurazione non scrive subito il file, evitando una finestra in cui un arresto durante startup possa perdere l'assegnazione.

## Sostituzione

Una modifica a `tuyaDeviceId`, oppure a `model`/`ip`/`mac` della camera, porta l'istanza a `pending`, elimina il runtime precedente e impedisce fallback su cache o immagini vecchie. Dopo una verifica read-only riuscita il runtime viene ricreato. Alias e ruolo non cambiano e una modifica del solo alias non ricrea il runtime.

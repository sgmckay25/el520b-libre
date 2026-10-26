# EL520B libre

Webapp pour piloter un vélo elliptique **Domyos EL520B** en Bluetooth, sans e-Connected ni Kinomap.
Elle tourne entièrement dans le navigateur (Web Bluetooth), sans compte ni serveur.

- Affichage en direct : vitesse, cadence, puissance, cardio, distance, calories
- Réglage de la résistance (1 à 15) depuis l'app
- Séances enregistrées dans le navigateur, export **TCX** (Strava, Garmin Connect, intervals.icu) et **CSV**
- Reconnexion automatique (la console auto-alimentée s'éteint dès qu'on arrête de pédaler)
- Onglet *Diagnostic Bluetooth* : services GATT, trames brutes décodées, journal à copier
- Mode *Simulation* pour essayer l'interface sans le vélo

**En ligne : <https://sgmckay25.github.io/el520b-libre/>**. Sur le téléphone, l'ouvrir dans Chrome puis
menu ⋮ › *Ajouter à l'écran d'accueil*.

## Navigateurs compatibles

Chrome ou Edge sur Android, Windows, macOS ou Linux. Sur iPhone, Safari ne gère pas le Web Bluetooth :
il faut passer par l'app gratuite **Bluefy**. La page doit être servie en **HTTPS** (ou via `localhost`).

## Lancer en local (PC)

```sh
python -m http.server 8520 --bind 127.0.0.1
```

puis ouvrir <http://localhost:8520> dans Chrome ou Edge.

## Protocoles

L'app détecte automatiquement le protocole (option forçable dans *Options de connexion*).

### FTMS (standard Bluetooth SIG), annoncé par l'EL520B

| Élément | UUID | Usage |
|---|---|---|
| Service Fitness Machine | `0x1826` | |
| Cross Trainer Data | `0x2ACE` | notifications : vitesse, pas/min, résistance, puissance, kcal, FC… |
| Indoor Bike Data | `0x2AD2` | repli si la machine se présente comme un vélo |
| Supported Resistance Level Range | `0x2AD6` | plage de résistance (au 1/10) |
| Fitness Machine Control Point | `0x2AD9` | `00` prise de contrôle, `04 xx` résistance (niveau × 10), `07` départ, `08 01` arrêt |
| Fitness Machine Status | `0x2ADA` | changements d'état |

Particularités Domyos, d'après [QZ](https://github.com/cagnulein/qdomyos-zwift) : cadence en tr/min = pas/min ÷ 2,
résistance renvoyée en niveau entier.

### Protocole propriétaire Domyos (anciens modèles `Domyos-EL…`)

Liaison série sur BLE (puce Microchip ISSC) :

- service `49535343-fe7d-4ae5-8fa9-9fafd205e455`
- écriture `49535343-8841-43f4-a8d4-ecbe34729bb3`, notifications `49535343-1e4d-4bd9-ba61-23c647249616`
- trames `f0 …` terminées par la somme des octets (mod 256), découpées en morceaux de 20 octets
- interrogation `f0 ac 9c` toutes les 300 ms. La console répond par 26 octets : vitesse `[6..7]/10` km/h,
  cadence `[9]`, kcal `[10..11]`, résistance `[14]`, FC `[18]`
- résistance : `f0 ad ff×8 <niveau> ff×6 00 01 ff ff ff <somme>`

## Fichiers

- `js/ftms.js` : pilote FTMS et décodage des trames
- `js/domyos.js` : pilote du protocole propriétaire
- `js/sim.js` : simulateur
- `js/session.js` : historique, exports TCX/CSV
- `js/app.js` : interface

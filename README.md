# Lokaal transcript

Webpagina voor iPad (en andere browsers) die gesprekken opneemt, transcribeert en sprekers onderscheidt. Alles in één scherm. De verwerking gebeurt op het apparaat met twee modellen van [Desert Ant Labs](https://desertant.com/models/):

* **Voz**: spraak naar tekst (25 talen, waaronder Nederlands), met tijd per woord.
* **Who**: wie sprak wanneer (sprekerdiarisatie).

## Werking

1. Eerste keer: tik op *Modellen laden*. De modellen (ongeveer 450 MB) komen van Hugging Face en worden in de browser bewaard. Daarna laden ze automatisch.
2. Tik op de opnameknop. Tijdens de opname verschijnt de tekst per blok van ongeveer 20 seconden.
3. Na het stoppen wordt het laatste stuk getranscribeerd en koppelt Who elk woord aan een spreker.
4. Tik op een sprekernaam om die te wijzigen. Exporteer als tekst of download de audio (WAV, 16 kHz mono).

Een bestaand audiobestand verwerken kan via *Audiobestand…*.

## Eisen

* iPadOS/Safari 26 of nieuwer (WebGPU en Float16Array). Getest in Chromium; niet getest op een echte iPad.
* Voldoende geheugen: Voz gebruikt volgens de leverancier ongeveer 1,2 GB, Who ongeveer 300 MB. Op iPads met weinig werkgeheugen kan Safari het tabblad afsluiten.
* De pagina moet via https (of localhost) worden geopend, anders geeft Safari geen toegang tot de microfoon. Een los HTML-bestand openen werkt dus niet.

## Bouwen en publiceren

```bash
npm install
npm run build     # schrijft de statische site naar docs/
```

Publiceer de map `docs/` op een statische host met https, bijvoorbeeld GitHub Pages (Settings › Pages › branch `main`, map `/docs`). De bestanden op de host zijn alleen code; audio en tekst verlaten het apparaat niet.

## Netwerkverkeer

* Eenmalig: modelbestanden van `huggingface.co`.
* Bij het laden van elk model: een licentiecontrole naar `events.desertant.com` met de domeinnaam van de site, een willekeurig installatie-id en de modelversie. Er gaat geen audio of tekst mee.

## Licentie

De SDK en modellen vallen onder de [Desert Ant Labs Source-Available License](https://license.desertant.com/1.0): gratis tot 100.000 maandelijks actieve apparaten per model, met naamsvermelding. Voz is gebaseerd op NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0).

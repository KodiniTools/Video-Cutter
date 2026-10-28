# Design-System · Tokens v2

Design Tokens des Video Cutters. Sie sind eine unveränderte Kopie der v2-Tokens des Collage Makers
(`KodiniTools/Collage-Maker`, `src/design-system/`, Stand `94d2471`), die ihrerseits aus dem
Playlist Generator stammen. So teilen alle Tools auf kodinitools.com dieselbe Palette, dieselben
Radien und dieselbe Motion. Werte werden im Collage Maker bzw. Playlist Generator gepflegt und
hierher übernommen; `tests/designTokens.spec.ts` hält JSON und CSS konsistent und prüft den
Kontrast (WCAG AA).

## Dateien

| Datei                             | Zweck                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tokens-v2.css`                   | **Laufzeit-Quelle.** CSS Custom Properties `--ds-*`, Dark auf `:root`, Light auf `[data-theme]`.     |
| `tokens-v2.json`                  | Maschinenlesbare Fassung (W3C-Design-Tokens-nah), `$extensions.css` nennt die Variable.              |
| `tokens-v2.ts`                    | Typisierter Zugriff für TS, z. B. `themeColorsV2('light')`.                                          |
| `tests/designTokens.spec.ts`      | Konsistenz JSON ↔ CSS, Light-Spiegelung, Namespace, Kontrast-Audit, Einbindung.                      |
| `tests/designSystemUsage.spec.ts` | Komponenten nutzen nur definierte `--ds-*`, keine alte `--vc-*`-Palette; SSI-Partials in index.html. |
| `tests/helpers/tokenTestUtils.ts` | CSS-Block-Parser, Token-Walker, Kontrastberechnung.                                                  |

## Theme-Mechanik

`src/stores/settings.ts` (aus dem Collage Maker übernommen) setzt `html[data-theme]` (für Tokens
und SSI-Partials) und `html.dark` (Altbestand für externe Skripte). Ein Inline-Skript in
`index.html` setzt `data-theme` vor dem ersten Paint aus `localStorage.theme`, damit es keinen
Dark-Flash gibt. Standard ist Light.

**Abweichung zum Collage Maker:** `body.light-theme` wird nicht gesetzt. Der Kodini Designer
überschreibt Farben auf `:root` (`src/content/site.ts`); ein Token-Block auf `<body>` würde diese
Overrides für alle App-Elemente verdecken.

## Rollen (ohne Tailwind)

Der Collage Maker bindet die Tokens über Tailwind-Klassen ein. Der Video Cutter nutzt scoped CSS
und referenziert die Variablen direkt – Rollen und Regeln sind dieselben:

| Rolle                        | Variable                                                       |
| ---------------------------- | -------------------------------------------------------------- |
| Seite, Panel, Eingabe, Hover | `--ds-surface-0` … `--ds-surface-3`                            |
| Rahmen, Feldrahmen           | `--ds-border`, `--ds-border-strong`                            |
| Text 1–3                     | `--ds-text`, `--ds-text-2`, `--ds-text-3`                      |
| Primäraktion                 | `--ds-accent`, `--ds-accent-hover`, Text `--ds-on-accent`      |
| Auswahl, aktive Fläche       | `--ds-accent-soft` mit Rahmen `--ds-accent`                    |
| Link, Status                 | `--ds-link`, `--ds-success`, `--ds-warning`, `--ds-danger`     |
| Radien                       | `--ds-radius-sm` (6) · `-md` (10) · `-lg` (16) · `-full`       |
| Schatten, Fokus              | `--ds-shadow-overlay` (nur Menüs/Overlays) · `--ds-focus-ring` |
| Motion                       | `--ds-duration` (150 ms) · `--ds-duration-slow` · `--ds-ease`  |
| Schrift                      | `--ds-font-sans`, `--ds-font-mono`, `--ds-text-xs…3xl`         |

App-eigener Token ohne Gegenstück: `--vc-playhead` (Abspielkopf der Timeline, Standard
`--ds-link`, im Designer über `theme.playhead` änderbar).

Regeln wie im Collage Maker: Gold ist Vollfläche nur für die Primäraktion, Fokus und aktive
Zustände (nie Textfarbe). Ein Rahmen (1 px), drei Radien, Schatten nur für Overlays. Hover ändert
Farbe, nie Größe. Destruktive Aktionen sind textbasiert (`--ds-danger`) auf einer flachen Fläche.

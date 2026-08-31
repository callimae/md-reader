# MD Reader

Lekki czytnik/edytor markdown w stylu Typory, zbudowany na Tauri 2.

- **Panel boczny** — ostatnio otwarte pliki, pogrupowane po folderach.
- **Edycja blokowa** — dokument jest wyrenderowany; kliknięty blok pokazuje surowy markdown, a po wyjściu wraca do ładnego widoku.

## Skróty

| Skrót | Działanie |
|-------|-----------|
| `Ctrl+O` | Otwórz plik |
| `Ctrl+S` | Zapisz (pyta o ścieżkę, jeśli plik nowy) |
| `Ctrl+Enter` / kliknięcie obok | Zatwierdź edycję bloku |
| `Escape` | Anuluj edycję bloku |

## Development

```bash
npm install
npm run tauri dev
```

## Budowanie wersji instalacyjnej

```bash
npm run tauri build
```

Gotowa binarka i instalator lądują w `src-tauri/target/release/`.

## Uwagi

- Puste linie między blokami są normalizowane do jednej przy zapisie.
- Lista ostatnich plików jest trzymana w `recents.json` w katalogu konfiguracji aplikacji.

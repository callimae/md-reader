# MD Reader

Lekki czytnik i edytor markdown dla Windows, w duchu Typory — darmowy i otwartoźródłowy. Zbudowany na Tauri 2, więc waży kilka megabajtów, a nie kilkaset.

> English version: [../README.md](../README.md)

![MD Reader — edycja blokowa z drzewem repozytorium](../docs/screenshot-pl.png)

## Dlaczego

Typora stała się płatna, Obsidian to kombajn. MD Reader robi jedno: czytasz ładnie wyrenderowany markdown, klikasz akapit, a on zamienia się w edytowalne źródło dokładnie pod kursorem. Klikasz obok — wraca do widoku.

## Funkcje

- **Edycja blokowa z podglądem na żywo** — dokument jest wyrenderowany; kliknięty blok pokazuje surowy markdown, z kursorem w miejscu kliknięcia. `Esc` anuluje, `Ctrl+Enter` (albo klik obok) zatwierdza.
- **Tryb repozytorium** — otwórz folder i przeglądaj drzewo plików markdown w panelu bocznym (`.git`, `node_modules` i katalogi wynikowe są pomijane). Otwarty folder wraca po restarcie.
- **Ostatnie pliki** — pogrupowane po folderach, o jedno kliknięcie.
- **Integracja z blogiem Hugo** — utwórz wpis (`Ctrl+N`) z gotowym front matter w dowolnej sekcji `content/`, przełącz `draft` jednym kliknięciem i opublikuj wbudowanym `git add / commit / push` — bez terminala.
- **Wyszukiwanie** — `Ctrl+F` w dokumencie (podświetlone trafienia, Enter przeskakuje), `Ctrl+Shift+F` po całym repozytorium.
- **Cofanie na poziomie dokumentu** — `Ctrl+Z` / `Ctrl+Y` działa też między zatwierdzonymi edycjami bloków.
- **Obrazki z repo** — ścieżki Hugo `/images/…` rozwiązują się względem `static/`, ścieżki względne — względem otwartego pliku.
- **Skróty formatowania** — `Ctrl+B` / `Ctrl+I` / `Ctrl+K` (pogrubienie, kursywa, link); Enter kontynuuje listy i cytaty.
- **Kolorowanie składni** w blokach kodu, dopasowane do motywu jasnego i ciemnego.
- **Dopracowane od początku** — panel ustawień (język PL/EN, motyw, rozmiar tekstu), zapamiętywanie stanu okna, przeciągnij i upuść, ochrona przed utratą zmian, licznik słów.

## Instalacja

Pobierz instalator (`.exe` lub `.msi`) z [Releases](../../releases). Windows SmartScreen może ostrzec przed nieznanym wydawcą — buildy nie są podpisane; kliknij „Więcej informacji → Uruchom mimo to" albo zbuduj ze źródeł (patrz niżej).

## Budowanie ze źródeł

Wymagania: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) i narzędzia MSVC.

```bash
cd mdreader
npm install
npm run tauri dev     # tryb deweloperski
npm run tauri build   # instalatory w src-tauri/target/release/bundle/
```

## Skróty

| Skrót | Działanie |
|-------|-----------|
| `Ctrl+O` | Otwórz plik |
| `Ctrl+N` | Nowy wpis na bloga |
| `Ctrl+S` | Zapisz |
| `Ctrl+F` | Znajdź w dokumencie |
| `Ctrl+Shift+F` | Szukaj w repozytorium |
| `Ctrl+Z` / `Ctrl+Y` | Cofnij / ponów |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Pogrubienie / kursywa / link |
| `Ctrl+Enter` | Zatwierdź edycję bloku |
| `Esc` | Anuluj edycję bloku / zamknij wyszukiwanie |

## Wsparcie

Jeśli MD Reader oszczędził Ci opłaty licencyjnej, możesz [postawić mi kawę](../../sponsors). ☕

## Licencja

[MIT](../LICENSE)

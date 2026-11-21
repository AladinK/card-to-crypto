# Kritične pravne i tehničke zavisnosti

Ovaj dokument navodi šta mora da bude rešeno pre nego što se bilo koji stvarni novac pokrene kroz sistem.
Nije pravni savet. Za svaku jurisdikciju u kojoj se posluje potrebna je pisana analiza advokata koji se bavi finansijskom regulativom i kripto-imovinom.

## A. Pravne zavisnosti (blokirajuće za live režim)

| # | Oblast | Šta je potrebno | Stanje u kodu |
|---|---|---|---|
| 1 | Licenca / registracija | Prijem fiat sredstava od kupaca i slanje kripto-imovine trgovcu može da zahteva dozvolu za pružanje usluga platnog prometa i/ili usluga u vezi sa kripto-imovinom. EU: MiCA (CASP autorizacija za usluge prenosa i razmene). Srbija: proveriti važeći zakon o digitalnoj imovini i nadležni organ (NBS, Komisija za hartije od vrednosti ili drugi nadležni organ) i da li je potrebna registracija ili dozvola. | Nije rešeno. Live režim je isključen dok se to ne reši. |
| 2 | Acquiring i pravila kartičnih šema | Procesor (acquirer) mora da odobri trgovačku kategoriju i model „plati karticom, primi kripto”. Visa i Mastercard imaju posebna pravila za kripto-povezane transakcije. | Nije rešeno. Stripe nalog mora da odobri model pre prvog live plaćanja. |
| 3 | AML / KYC / KYB | Program sprečavanja pranja novca, identifikacija trgovca (KYB) i krajnjeg vlasnika, praćenje transakcija, prijava sumnjivih aktivnosti. | Delimično: KYB odluka je ručna (admin endpoint). Nema KYC provajdera. |
| 4 | Travel Rule | FATF Preporuka 16 i EU Uredba o transferu sredstava (EU) 2023/1113 zahtevaju podatke o pošiljaocu i primaocu uz kripto transfer. | Nije implementirano. Potreban provajder ili protokol. |
| 5 | Sankcije | Provera kupaca, trgovaca i adresa novčanika protiv OFAC, EU, UK i lokalnih lista. | Interfejs postoji. Bez provajdera, live settlement je zadržan (fail-closed). |
| 6 | USDT u EU | MiCA ograničava stablecoin-e i neke usluge sa njima. Pre aktiviranja USDT-a za EU trgovce potrebna je posebna provera. | USDT je u konfiguraciji, ali nije aktiviran za live. |
| 7 | PCI DSS | Hosted checkout (SAQ A) kod procesora. Sistem nikada ne prima PAN ni CVV. | Ispunjeno dizajnom. Potvrditi u ugovoru sa procesorom. |
| 8 | Porez | Izveštavanje o transakcijama kripto-imovine (EU DAC8, primenjuje se od 2026). PDV i porez na dobit za konverziju i naknade. | Nije implementirano. |
| 9 | Privatnost | GDPR (ili lokalni ekvivalent) za podatke kupaca: pravni osnov, rok čuvanja, prava lica, ugovori o obradi. Podaci o kupcima se čuvaju u PostgreSQL bazi; treba definisati politiku brisanja. | Delimično: minimalni skup podataka, bez praćenja. Nema politike zadržavanja. |
| 10 | Uslovi korišćenja i refund | Ugovor sa trgovcem: odgovornost za povraćaj, nepovratnost naknada, odgovornost za kripto-povraćaj. Vidi docs/REFUND_POLICY.md. | Nacrt politike. Potrebna pravna revizija. |
| 11 | Rizik likvidnosti | Platforma mora da drži fiat float za povraćaje i kripto treasury za settlement. Regulator može tražiti zaštitne mehanizme za sredstva klijenata. | Nije rešeno (operativni i finansijski zahtev). |

## B. Tehničke zavisnosti (blokirajuće za live režim)

| # | Zavisnost | Zašto je kritična | Stanje |
|---|---|---|---|
| 1 | Izvor kursa sa SLA | CoinGecko javni nivo nema SLA ni garancije. Pogrešan kurs znači gubitak treasury-ja. | Implementiran adapter; zameniti ugovorenim izvorom (npr. exchange API, Chainlink, OTC partner). |
| 2 | Treasury likvidnost | Settlement zahteva unapred finansirani treasury (USDC na svakom aktivnom chain-u). Konverziju fiat→USDC rešava exchange ili OTC partner. | Provera balansa je implementirana; konverzija fiat→kripto nije povezana. |
| 3 | Treasury signer (KMS/HSM) | Privatni ključ ne sme biti u env varijabli u produkciji. | Interfejs `Signer` postoji. Env signer je dozvoljen samo na stagingu. KMS/HSM nije implementiran. |
| 4 | RPC provajderi | Jedan RPC je jedna tačka otkaza. Potrebni su najmanje dva po chain-u, sa rate limitima i SLA. | viem fallback je implementiran. Potrebna konfiguracija. |
| 5 | Gas politika | Fee bump (replacement) za zaglavljene transakcije, nadzor mempool-a. | Otkrivanje zaglavljenih transakcija i rebroadcast su implementirani; replacement (speed-up) nije. |
| 6 | Reorg zaštita | Dubina potvrda po chain-u mora da odgovara riziku. | Podrazumevane vrednosti u `core/assets.ts`, konfigurabilne. |
| 7 | Fiat float za refund | Refund se izvršava u fiat-u, a kripto je već poslat. Platforma nosi razliku dok trgovac ne vrati iznos. | Evidencija „open crypto recovery” postoji. Naplata/netting nije automatizovan. |
| 8 | Monitoring i alarmi | Zaglavljene transakcije, nedovoljan balans treasury-ja, neuspeli webhook-ovi, DLQ. | Metrike su u admin health endpointu; nema Prometheus/Grafana integracije. |
| 9 | Redundantnost | Više API replika, worker replika, backup baze, PITR. | Docker compose je primer; produkcijska infrastruktura nije isporučena. |
| 10 | Sigurnosna revizija | Nezavisni penetracioni test, revizija smart-kontrakata (ovaj sistem ih ne deploy-uje, ali koristi ERC-20 stablecoin-e). | Nije urađeno. |

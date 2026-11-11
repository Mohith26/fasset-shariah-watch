"""Fetch public inputs for Shariah Watch (outputs committed in raw/).
SEC XBRL companyfacts (data.sec.gov, public, User-Agent required) -> balance-sheet debt,
cash + interest-bearing securities and shares outstanding per filing.
Yahoo Finance chart API -> daily close + split events (to rebuild unadjusted prices).
Run: python3 scripts/fetch_data.py   (about 3 minutes; respects SEC 10 req/s)
"""
import json, os, time, urllib.request, sys
UA = 'Mohith Gajjela mohithgajjela@gmail.com'
TICKERS = ("AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO ORCL ADBE CRM CSCO INTC AMD QCOM TXN IBM MU AMAT LRCX "
  "KLAC ADI NXPI MCHP ON INTU NOW SNPS CDNS PANW FTNT ANET DELL HPQ HPE WDC STX GLW KEYS TER "
  "JNJ PFE MRK ABBV LLY BMY AMGN GILD REGN VRTX BIIB MRNA ZTS TMO DHR ABT MDT SYK BSX ISRG EW BDX BAX "
  "PG KO PEP CL KMB GIS K KHC MDLZ HSY CPB CAG SJM MKC CLX CHD KDP MNST "
  "XOM CVX COP EOG OXY SLB HAL BKR DVN MPC PSX VLO KMI WMB OKE "
  "NEE DUK SO D AEP EXC XEL SRE PEG ED "
  "VZ T TMUS CMCSA CHTR "
  "HD LOW NKE SBUX MCD TGT COST WMT TJX ROST DG DLTR BBY EBAY F GM APTV "
  "BA LMT GE HON MMM CAT DE UNP UPS FDX CSX NSC EMR ETN ITW PH ROK "
  "LIN APD SHW ECL DD DOW NUE FCX NEM IP").split()
os.makedirs('raw', exist_ok=True)
def get(url, ua=UA):
    req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
tick = get('https://www.sec.gov/files/company_tickers.json')
cik = {v['ticker']: str(v['cik_str']).zfill(10) for v in tick.values()}
DEBT = ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings', 'CommercialPaper',
        'LongTermDebtAndCapitalLeaseObligations', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'DebtLongtermAndShorttermCombinedAmount', 'OtherShortTermBorrowings']
CASH = ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsAndShortTermInvestments', 'ShortTermInvestments', 'MarketableSecuritiesCurrent',
        'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'MarketableSecuritiesNoncurrent', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent', 'LongTermInvestments', 'Cash']
out = {}
for t in TICKERS:
    c = cik.get(t.replace('.', '-'))
    if not c: print('no cik', t); continue
    try:
        f = get(f'https://data.sec.gov/api/xbrl/companyfacts/CIK{c}.json')
    except Exception as e:
        print('sec fail', t, e); continue
    g = f['facts'].get('us-gaap', {}); dei = f['facts'].get('dei', {})
    rec = {'cik': c, 'name': f.get('entityName'), 'facts': {}}
    for tag in DEBT + CASH:
        if tag in g and 'USD' in g[tag]['units']:
            rows = {}
            for u in g[tag]['units']['USD']:
                if u.get('form') not in ('10-Q', '10-K', '10-Q/A', '10-K/A') or 'start' in u: continue
                k = (u['end'], u['filed'])
                rows[k] = u['val']
            rec['facts'][tag] = sorted([[e, fl, v] for (e, fl), v in rows.items()])
    sh = {}
    for src in (dei.get('EntityCommonStockSharesOutstanding', {}).get('units', {}).get('shares', []),
                g.get('CommonStockSharesOutstanding', {}).get('units', {}).get('shares', [])):
        for u in src:
            if u.get('form', '').startswith(('10-Q', '10-K')): sh.setdefault((u['end'], u['filed']), 0); sh[(u['end'], u['filed'])] += 0; sh[(u['end'], u['filed'])] = max(sh[(u['end'], u['filed'])], u['val'])
    rec['shares'] = sorted([[e, fl, v] for (e, fl), v in sh.items()])
    try:
        y = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{t}?period1=1293840000&period2=1794400000&interval=1d&events=split', 'Mozilla/5.0')
        r = y['chart']['result'][0]
        rec['px'] = {'t': r['timestamp'], 'c': [None if v is None else round(v, 4) for v in r['indicators']['quote'][0]['close']]}
        rec['splits'] = [[s['date'], s['numerator'], s['denominator']] for s in (r.get('events', {}).get('splits', {}) or {}).values()]
    except Exception as e:
        print('px fail', t, e); continue
    out[t] = rec
    print(t, len(rec['facts']), len(rec['shares']), len(rec['px']['t']), flush=True)
    time.sleep(0.15)
json.dump(out, open('raw/fundamentals_prices.json', 'w'))
print('done', len(out))

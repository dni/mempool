import config from '../config';
import bitcoinApi, { bitcoinCoreApi } from './bitcoin/bitcoin-api-factory';
import { MempoolTransactionExtended, TransactionExtended, VbytesPerSecond } from '../mempool.interfaces';
import logger from '../logger';
import { Common } from './common';
import transactionUtils from './transaction-utils';
import { IBitcoinApi } from './bitcoin/bitcoin-api.interface';
import loadingIndicators from './loading-indicators';
import bitcoinClient from './bitcoin/bitcoin-client';
import bitcoinSecondClient from './bitcoin/bitcoin-second-client';
import rbfCache from './rbf-cache';
import { IEsploraApi } from './bitcoin/esplora-api.interface';

class Mempool {
  private inSync: boolean = false;
  private mempoolCacheDelta: number = -1;
  private mempoolCache: { [txId: string]: MempoolTransactionExtended } = {};
  private spendMap = new Map<string, MempoolTransactionExtended>();
  private mempoolInfo: IBitcoinApi.MempoolInfo = { loaded: false, size: 0, bytes: 0, usage: 0, total_fee: 0,
                                                    maxmempool: 300000000, mempoolminfee: 0.00001000, minrelaytxfee: 0.00001000 };
  private mempoolChangedCallback: ((newMempool: {[txId: string]: MempoolTransactionExtended; }, newTransactions: MempoolTransactionExtended[],
    deletedTransactions: MempoolTransactionExtended[]) => void) | undefined;
  private $asyncMempoolChangedCallback: ((newMempool: {[txId: string]: MempoolTransactionExtended; }, mempoolSize: number, newTransactions: MempoolTransactionExtended[],
    deletedTransactions: MempoolTransactionExtended[]) => Promise<void>) | undefined;

  private txPerSecondArray: number[] = [];
  private txPerSecond: number = 0;

  private vBytesPerSecondArray: VbytesPerSecond[] = [];
  private vBytesPerSecond: number = 0;
  private mempoolProtection = 0;
  private latestTransactions: any[] = [];

  private ESPLORA_MISSING_TX_WARNING_THRESHOLD = 100; 
  private SAMPLE_TIME = 10000; // In ms
  private timer = new Date().getTime();
  private missingTxCount = 0;
  private mainLoopTimeout: number = 120000;

  constructor() {
    setInterval(this.updateTxPerSecond.bind(this), 1000);
  }

  /**
   * Return true if we should leave resources available for mempool tx caching
   */
  public hasPriority(): boolean {
    if (this.inSync) {
      return false;
    } else {
      return this.mempoolCacheDelta == -1 || this.mempoolCacheDelta > 25;
    }
  }

  public isInSync(): boolean {
    return this.inSync;
  }

  public setOutOfSync(): void {
    this.inSync = false;
    loadingIndicators.setProgress('mempool', 99);
  }

  public getLatestTransactions() {
    return this.latestTransactions;
  }

  public setMempoolChangedCallback(fn: (newMempool: { [txId: string]: MempoolTransactionExtended; },
    newTransactions: MempoolTransactionExtended[], deletedTransactions: MempoolTransactionExtended[]) => void): void {
    this.mempoolChangedCallback = fn;
  }

  public setAsyncMempoolChangedCallback(fn: (newMempool: { [txId: string]: MempoolTransactionExtended; }, mempoolSize: number,
    newTransactions: MempoolTransactionExtended[], deletedTransactions: MempoolTransactionExtended[]) => Promise<void>): void {
    this.$asyncMempoolChangedCallback = fn;
  }

  public getMempool(): { [txid: string]: MempoolTransactionExtended } {
    return this.mempoolCache;
  }

  public getSpendMap(): Map<string, MempoolTransactionExtended> {
    return this.spendMap;
  }

  public async $setMempool(mempoolData: { [txId: string]: MempoolTransactionExtended }) {
    this.mempoolCache = mempoolData;
    let count = 0;
    for (const txid of Object.keys(this.mempoolCache)) {
      if (!this.mempoolCache[txid].sigops || this.mempoolCache[txid].effectiveFeePerVsize == null) {
        this.mempoolCache[txid] = transactionUtils.extendMempoolTransaction(this.mempoolCache[txid]);
      }
      if (this.mempoolCache[txid].order == null) {
        this.mempoolCache[txid].order = transactionUtils.txidToOrdering(txid);
      }
      count++;
    }
    if (this.mempoolChangedCallback) {
      this.mempoolChangedCallback(this.mempoolCache, [], []);
    }
    if (this.$asyncMempoolChangedCallback) {
      await this.$asyncMempoolChangedCallback(this.mempoolCache, count, [], []);
    }
    this.addToSpendMap(Object.values(this.mempoolCache));
  }

  public async $reloadMempool(expectedCount: number): Promise<MempoolTransactionExtended[]> {
    let count = 0;
    let done = false;
    let last_txid;
    const newTransactions: MempoolTransactionExtended[] = [];
    loadingIndicators.setProgress('mempool', count / expectedCount * 100);
    while (!done) {
      try {
        const result = await bitcoinApi.$getMempoolTransactions(last_txid);
        if (result) {
          for (const tx of result) {
            const extendedTransaction = transactionUtils.extendMempoolTransaction(tx);
            if (!this.mempoolCache[extendedTransaction.txid]) {
              newTransactions.push(extendedTransaction);
              this.mempoolCache[extendedTransaction.txid] = extendedTransaction;
            }
            count++;
          }
          logger.info(`Fetched ${count} of ${expectedCount} mempool transactions from esplora`);
          if (result.length > 0) {
            last_txid = result[result.length - 1].txid;
          } else {
            done = true;
          }
          if (Math.floor((count / expectedCount) * 100) < 100) {
            loadingIndicators.setProgress('mempool', count / expectedCount * 100);
          }
        } else {
          done = true;
        }
      } catch(err) {
        logger.err('failed to fetch bulk mempool transactions from esplora');
      }
    }
    return newTransactions;
    logger.info(`Done inserting loaded mempool transactions into local cache`);
  }

  public async $updateMemPoolInfo() {
    this.mempoolInfo = await this.$getMempoolInfo();
  }

  public getMempoolInfo(): IBitcoinApi.MempoolInfo {
    return this.mempoolInfo;
  }

  public getTxPerSecond(): number {
    return this.txPerSecond;
  }

  public getVBytesPerSecond(): number {
    return this.vBytesPerSecond;
  }

  public getFirstSeenForTransactions(txIds: string[]): number[] {
    const txTimes: number[] = [];
    txIds.forEach((txId: string) => {
      const tx = this.mempoolCache[txId];
      if (tx && tx.firstSeen) {
        txTimes.push(tx.firstSeen);
      } else {
        txTimes.push(0);
      }
    });
    return txTimes;
  }

  public async $updateMempool(transactions: string[]): Promise<void> {
    logger.debug(`Updating mempool...`);

    // warn if this run stalls the main loop for more than 2 minutes
    const timer = this.startTimer();

    const start = new Date().getTime();
    let hasChange: boolean = false;
    const currentMempoolSize = Object.keys(this.mempoolCache).length;
    this.updateTimerProgress(timer, 'got raw mempool');
    const diff = transactions.length - currentMempoolSize;
    let newTransactions: MempoolTransactionExtended[] = [];

    this.mempoolCacheDelta = Math.abs(diff);

    if (!this.inSync) {
      loadingIndicators.setProgress('mempool', currentMempoolSize / transactions.length * 100);
    }

    // https://github.com/mempool/mempool/issues/3283
    const logEsplora404 = (missingTxCount, threshold, time) => {
      const log = `In the past ${time / 1000} seconds, esplora tx API replied ${missingTxCount} times with a 404 error code while updating nodejs backend mempool`;
      if (missingTxCount >= threshold) {
        logger.warn(log);
      } else if (missingTxCount > 0) {
        logger.debug(log);
      }
    };

    let intervalTimer = Date.now();

    let loaded = false;
    if (config.MEMPOOL.BACKEND === 'esplora' && currentMempoolSize < transactions.length * 0.5 && transactions.length > 20_000) {
      this.inSync = false;
      logger.info(`Missing ${transactions.length - currentMempoolSize} mempool transactions, attempting to reload in bulk from esplora`);
      try {
        newTransactions = await this.$reloadMempool(transactions.length);
        loaded = true;
      } catch (e) {
        logger.err('failed to load mempool in bulk from esplora, falling back to fetching individual transactions');
      }
    }

    if (!loaded) {
      for (const txid of transactions) {
        if (!this.mempoolCache[txid]) {
          try {
            const transaction = await transactionUtils.$getMempoolTransactionExtended(txid, false, false, false);
            this.updateTimerProgress(timer, 'fetched new transaction');
            this.mempoolCache[txid] = transaction;
            if (this.inSync) {
              this.txPerSecondArray.push(new Date().getTime());
              this.vBytesPerSecondArray.push({
                unixTime: new Date().getTime(),
                vSize: transaction.vsize,
              });
            }
            hasChange = true;
            newTransactions.push(transaction);
          } catch (e: any) {
            if (config.MEMPOOL.BACKEND === 'esplora' && e.response?.status === 404) {
              this.missingTxCount++;
            }
            logger.debug(`Error finding transaction '${txid}' in the mempool: ` + (e instanceof Error ? e.message : e));
          }
        }

        if (Date.now() - intervalTimer > 5_000) {
          if (this.inSync) {
            // Break and restart mempool loop if we spend too much time processing
            // new transactions that may lead to falling behind on block height
            logger.debug('Breaking mempool loop because the 5s time limit exceeded.');
            break;
          } else {
            const progress = (currentMempoolSize + newTransactions.length) / transactions.length * 100;
            logger.debug(`Mempool is synchronizing. Processed ${newTransactions.length}/${diff} txs (${Math.round(progress)}%)`);
            if (Math.floor(progress) < 100) {
              loadingIndicators.setProgress('mempool', progress);
            }
            intervalTimer = Date.now()
          }
        }
      }
    }

    // Reset esplora 404 counter and log a warning if needed
    const elapsedTime = new Date().getTime() - this.timer;
    if (elapsedTime > this.SAMPLE_TIME) {
      logEsplora404(this.missingTxCount, this.ESPLORA_MISSING_TX_WARNING_THRESHOLD, elapsedTime);
      this.timer = new Date().getTime();
      this.missingTxCount = 0;
    }

    // Prevent mempool from clear on bitcoind restart by delaying the deletion
    if (this.mempoolProtection === 0
      && currentMempoolSize > 20000
      && transactions.length / currentMempoolSize <= 0.80
    ) {
      this.mempoolProtection = 1;
      this.inSync = false;
      logger.warn(`Mempool clear protection triggered because transactions.length: ${transactions.length} and currentMempoolSize: ${currentMempoolSize}.`);
      setTimeout(() => {
        this.mempoolProtection = 2;
        logger.warn('Mempool clear protection ended, normal operation resumed.');
      }, 1000 * 60 * config.MEMPOOL.CLEAR_PROTECTION_MINUTES);
    }

    const deletedTransactions: MempoolTransactionExtended[] = [];

    if (this.mempoolProtection !== 1) {
      this.mempoolProtection = 0;
      // Index object for faster search
      const transactionsObject = {};
      transactions.forEach((txId) => transactionsObject[txId] = true);

      // Delete evicted transactions from mempool
      for (const tx in this.mempoolCache) {
        if (!transactionsObject[tx]) {
          deletedTransactions.push(this.mempoolCache[tx]);
        }
      }
      for (const tx of deletedTransactions) {
        delete this.mempoolCache[tx.txid];
      }
    }

    const newMempoolSize = currentMempoolSize + newTransactions.length - deletedTransactions.length;
    const newTransactionsStripped = newTransactions.map((tx) => Common.stripTransaction(tx));
    this.latestTransactions = newTransactionsStripped.concat(this.latestTransactions).slice(0, 6);

    this.mempoolCacheDelta = Math.abs(transactions.length - newMempoolSize);

    if (this.mempoolChangedCallback && (hasChange || deletedTransactions.length)) {
      this.mempoolChangedCallback(this.mempoolCache, newTransactions, deletedTransactions);
    }
    if (this.$asyncMempoolChangedCallback && (hasChange || deletedTransactions.length)) {
      this.updateTimerProgress(timer, 'running async mempool callback');
      await this.$asyncMempoolChangedCallback(this.mempoolCache, newMempoolSize, newTransactions, deletedTransactions);
      this.updateTimerProgress(timer, 'completed async mempool callback');
    }

    if (!this.inSync && transactions.length === newMempoolSize) {
      this.inSync = true;
      logger.notice('The mempool is now in sync!');
      loadingIndicators.setProgress('mempool', 100);
    }

    const end = new Date().getTime();
    const time = end - start;
    logger.debug(`Mempool updated in ${time / 1000} seconds. New size: ${Object.keys(this.mempoolCache).length} (${diff > 0 ? '+' + diff : diff})`);

    this.clearTimer(timer);
  }

  private startTimer() {
    const state: any = {
      start: Date.now(),
      progress: 'begin $updateMempool',
      timer: null,
    };
    state.timer = setTimeout(() => {
      logger.err(`$updateMempool stalled at "${state.progress}"`);
    }, this.mainLoopTimeout);
    return state;
  }

  private updateTimerProgress(state, msg) {
    state.progress = msg;
  }

  private clearTimer(state) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }

  public handleRbfTransactions(rbfTransactions: { [txid: string]: MempoolTransactionExtended[]; }): void {
    for (const rbfTransaction in rbfTransactions) {
      if (this.mempoolCache[rbfTransaction] && rbfTransactions[rbfTransaction]?.length) {
        // Store replaced transactions
        rbfCache.add(rbfTransactions[rbfTransaction], this.mempoolCache[rbfTransaction]);
      }
    }
  }

  public handleMinedRbfTransactions(rbfTransactions: { [txid: string]: { replaced: MempoolTransactionExtended[], replacedBy: TransactionExtended }}): void {
    for (const rbfTransaction in rbfTransactions) {
      if (rbfTransactions[rbfTransaction].replacedBy && rbfTransactions[rbfTransaction]?.replaced?.length) {
        // Store replaced transactions
        rbfCache.add(rbfTransactions[rbfTransaction].replaced, transactionUtils.extendMempoolTransaction(rbfTransactions[rbfTransaction].replacedBy));
      }
    }
  }

  public addToSpendMap(transactions: MempoolTransactionExtended[]): void {
    for (const tx of transactions) {
      for (const vin of tx.vin) {
        this.spendMap.set(`${vin.txid}:${vin.vout}`, tx);
      }
    }
  }

  public removeFromSpendMap(transactions: TransactionExtended[]): void {
    for (const tx of transactions) {
      for (const vin of tx.vin) {
        const key = `${vin.txid}:${vin.vout}`;
        if (this.spendMap.get(key)?.txid === tx.txid) {
          this.spendMap.delete(key);
        }
      }
    }
  }

  private updateTxPerSecond() {
    const nowMinusTimeSpan = new Date().getTime() - (1000 * config.STATISTICS.TX_PER_SECOND_SAMPLE_PERIOD);
    this.txPerSecondArray = this.txPerSecondArray.filter((unixTime) => unixTime > nowMinusTimeSpan);
    this.txPerSecond = this.txPerSecondArray.length / config.STATISTICS.TX_PER_SECOND_SAMPLE_PERIOD || 0;

    this.vBytesPerSecondArray = this.vBytesPerSecondArray.filter((data) => data.unixTime > nowMinusTimeSpan);
    if (this.vBytesPerSecondArray.length) {
      this.vBytesPerSecond = Math.round(
        this.vBytesPerSecondArray.map((data) => data.vSize).reduce((a, b) => a + b) / config.STATISTICS.TX_PER_SECOND_SAMPLE_PERIOD
      );
    }
  }

  private $getMempoolInfo() {
    if (config.MEMPOOL.USE_SECOND_NODE_FOR_MINFEE) {
      return Promise.all([
        bitcoinClient.getMempoolInfo(),
        bitcoinSecondClient.getMempoolInfo()
      ]).then(([mempoolInfo, secondMempoolInfo]) => {
        mempoolInfo.maxmempool = secondMempoolInfo.maxmempool;
        mempoolInfo.mempoolminfee = secondMempoolInfo.mempoolminfee;
        mempoolInfo.minrelaytxfee = secondMempoolInfo.minrelaytxfee;
        return mempoolInfo;
      });
    }
    return bitcoinClient.getMempoolInfo();
  }
}

export default new Mempool();

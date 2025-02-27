import * as nacl from './nacl/naclWrappers';
import * as address from './encoding/address';
import * as encoding from './encoding/encoding';
import * as logic from './logic/logic';
import * as multisig from './multisig';
import * as utils from './utils/utils';
import * as txnBuilder from './transaction';
import {
  EncodedLogicSig,
  EncodedLogicSigAccount,
  EncodedMultisig,
  EncodedSignedTransaction,
} from './types/transactions/encoded';
import { MultisigMetadata } from './types/multisig';

interface LogicSigStorageStructure {
  logic: Uint8Array;
  args: Uint8Array[];
  sig?: Uint8Array;
  msig?: EncodedMultisig;
}

/**
 LogicSig implementation
 */
export class LogicSig implements LogicSigStorageStructure {
  tag = Buffer.from('Program');

  logic: Uint8Array;
  args: Uint8Array[];
  sig?: Uint8Array;
  msig?: EncodedMultisig;

  constructor(
    program: Uint8Array,
    programArgs?: Array<Uint8Array | Buffer> | null
  ) {
    if (
      programArgs &&
      (!Array.isArray(programArgs) ||
        !programArgs.every(
          (arg) => arg.constructor === Uint8Array || Buffer.isBuffer(arg)
        ))
    ) {
      throw new TypeError('Invalid arguments');
    }

    let args: Uint8Array[] | undefined;
    if (programArgs != null)
      args = programArgs.map((arg) => new Uint8Array(arg));

    if (!logic.checkProgram(program, args)) {
      throw new Error('Invalid program');
    }

    this.logic = program;
    this.args = args;
    this.sig = undefined;
    this.msig = undefined;
  }

  // eslint-disable-next-line camelcase
  get_obj_for_encoding() {
    const obj: EncodedLogicSig = {
      l: this.logic,
    };
    if (this.args) {
      obj.arg = this.args;
    }
    if (this.sig) {
      obj.sig = this.sig;
    } else if (this.msig) {
      obj.msig = this.msig;
    }
    return obj;
  }

  // eslint-disable-next-line camelcase
  static from_obj_for_encoding(encoded: EncodedLogicSig) {
    const lsig = new LogicSig(encoded.l, encoded.arg);
    lsig.sig = encoded.sig;
    lsig.msig = encoded.msig;
    return lsig;
  }

  /**
   * Performs signature verification
   * @param publicKey - Verification key (derived from sender address or escrow address)
   */
  verify(publicKey: Uint8Array) {
    if (this.sig && this.msig) {
      return false;
    }

    try {
      logic.checkProgram(this.logic, this.args);
    } catch (e) {
      return false;
    }

    const toBeSigned = utils.concatArrays(this.tag, this.logic);

    if (!this.sig && !this.msig) {
      const hash = nacl.genericHash(toBeSigned);
      return utils.arrayEqual(hash, publicKey);
    }

    if (this.sig) {
      return nacl.verify(toBeSigned, this.sig, publicKey);
    }

    return multisig.verifyMultisig(toBeSigned, this.msig, publicKey);
  }

  /**
   * Compute hash of the logic sig program (that is the same as escrow account address) as string address
   * @returns String representation of the address
   */
  address() {
    const toBeSigned = utils.concatArrays(this.tag, this.logic);
    const hash = nacl.genericHash(toBeSigned);
    return address.encodeAddress(new Uint8Array(hash));
  }

  /**
   * Creates signature (if no msig provided) or multi signature otherwise
   * @param secretKey - Secret key to sign with
   * @param msig - Multisig account as \{version, threshold, addrs\}
   */
  sign(secretKey: Uint8Array, msig?: MultisigMetadata) {
    if (msig == null) {
      this.sig = this.signProgram(secretKey);
    } else {
      const subsigs = msig.addrs.map((addr) => ({
        pk: address.decodeAddress(addr).publicKey,
      }));

      this.msig = {
        v: msig.version,
        thr: msig.threshold,
        subsig: subsigs,
      };

      const [sig, index] = this.singleSignMultisig(secretKey, this.msig);
      this.msig.subsig[index].s = sig;
    }
  }

  /**
   * Appends a signature to multi signature
   * @param secretKey - Secret key to sign with
   */
  appendToMultisig(secretKey: Uint8Array) {
    if (this.msig === undefined) {
      throw new Error('no multisig present');
    }
    const [sig, index] = this.singleSignMultisig(secretKey, this.msig);
    this.msig.subsig[index].s = sig;
  }

  signProgram(secretKey: Uint8Array) {
    const toBeSigned = utils.concatArrays(this.tag, this.logic);
    const sig = nacl.sign(toBeSigned, secretKey);
    return sig;
  }

  singleSignMultisig(
    secretKey: Uint8Array,
    msig: EncodedMultisig
  ): [sig: Uint8Array, index: number] {
    let index = -1;
    const myPk = nacl.keyPairFromSecretKey(secretKey).publicKey;
    for (let i = 0; i < msig.subsig.length; i++) {
      const { pk } = msig.subsig[i];
      if (utils.arrayEqual(pk, myPk)) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      throw new Error('invalid secret key');
    }
    const sig = this.signProgram(secretKey);
    return [sig, index];
  }

  toByte() {
    return encoding.encode(this.get_obj_for_encoding());
  }

  static fromByte(encoded: ArrayLike<any>) {
    const decodedObj = encoding.decode(encoded) as EncodedLogicSig;
    return LogicSig.from_obj_for_encoding(decodedObj);
  }
}

/**
 * Represents an account that can sign with a LogicSig program.
 */
export class LogicSigAccount {
  lsig: LogicSig;
  sigkey?: Uint8Array;

  /**
   * Create a new LogicSigAccount. By default this will create an escrow
   * LogicSig account. Call `sign` or `signMultisig` on the newly created
   * LogicSigAccount to make it a delegated account.
   *
   * @param program - The compiled TEAL program which contains the logic for
   *   this LogicSig.
   * @param args - An optional array of arguments for the program.
   */
  constructor(program: Uint8Array, args?: Array<Uint8Array | Buffer> | null) {
    this.lsig = new LogicSig(program, args);
    this.sigkey = undefined;
  }

  // eslint-disable-next-line camelcase
  get_obj_for_encoding() {
    const obj: EncodedLogicSigAccount = {
      lsig: this.lsig.get_obj_for_encoding(),
    };
    if (this.sigkey) {
      obj.sigkey = this.sigkey;
    }
    return obj;
  }

  // eslint-disable-next-line camelcase
  static from_obj_for_encoding(encoded: EncodedLogicSigAccount) {
    const lsigAccount = new LogicSigAccount(encoded.lsig.l, encoded.lsig.arg);
    lsigAccount.lsig = LogicSig.from_obj_for_encoding(encoded.lsig);
    lsigAccount.sigkey = encoded.sigkey;
    return lsigAccount;
  }

  /**
   * Encode this object into msgpack.
   */
  toByte() {
    return encoding.encode(this.get_obj_for_encoding());
  }

  /**
   * Decode a msgpack object into a LogicSigAccount.
   * @param encoded - The encoded LogicSigAccount.
   */
  static fromByte(encoded: ArrayLike<any>) {
    const decodedObj = encoding.decode(encoded) as EncodedLogicSigAccount;
    return LogicSigAccount.from_obj_for_encoding(decodedObj);
  }

  /**
   * Check if this LogicSigAccount has been delegated to another account with a
   * signature.
   *
   * Note this function only checks for the presence of a delegation signature.
   * To verify the delegation signature, use `verify`.
   */
  isDelegated() {
    return !!(this.lsig.sig || this.lsig.msig);
  }

  /**
   * Verifies this LogicSig's program and signatures.
   * @returns true if and only if the LogicSig program and signatures are valid.
   */
  verify() {
    const addr = this.address();
    return this.lsig.verify(address.decodeAddress(addr).publicKey);
  }

  /**
   * Get the address of this LogicSigAccount.
   *
   * If the LogicSig is delegated to another account, this will return the
   * address of that account.
   *
   * If the LogicSig is not delegated to another account, this will return an
   *  escrow address that is the hash of the LogicSig's program code.
   */
  address() {
    if (this.lsig.sig && this.lsig.msig) {
      throw new Error(
        'LogicSig has too many signatures. At most one of sig or msig may be present'
      );
    }

    if (this.lsig.sig) {
      if (!this.sigkey) {
        throw new Error('Signing key for delegated account is missing');
      }
      return address.encodeAddress(this.sigkey);
    }

    if (this.lsig.msig) {
      const msigMetadata = {
        version: this.lsig.msig.v,
        threshold: this.lsig.msig.thr,
        pks: this.lsig.msig.subsig.map((subsig) => subsig.pk),
      };
      return address.encodeAddress(address.fromMultisigPreImg(msigMetadata));
    }

    return this.lsig.address();
  }

  /**
   * Turns this LogicSigAccount into a delegated LogicSig. This type of LogicSig
   * has the authority to sign transactions on behalf of another account, called
   * the delegating account. Use this function if the delegating account is a
   * multisig account.
   *
   * @param msig - The multisig delegating account
   * @param secretKey - The secret key of one of the members of the delegating
   *   multisig account. Use `appendToMultisig` to add additional signatures
   *   from other members.
   */
  signMultisig(msig: MultisigMetadata, secretKey: Uint8Array) {
    this.lsig.sign(secretKey, msig);
  }

  /**
   * Adds an additional signature from a member of the delegating multisig
   * account.
   *
   * @param secretKey - The secret key of one of the members of the delegating
   *   multisig account.
   */
  appendToMultisig(secretKey: Uint8Array) {
    this.lsig.appendToMultisig(secretKey);
  }

  /**
   * Turns this LogicSigAccount into a delegated LogicSig. This type of LogicSig
   * has the authority to sign transactions on behalf of another account, called
   * the delegating account. If the delegating account is a multisig account,
   * use `signMultisig` instead.
   *
   * @param secretKey - The secret key of the delegating account.
   */
  sign(secretKey: Uint8Array) {
    this.lsig.sign(secretKey);
    this.sigkey = nacl.keyPairFromSecretKey(secretKey).publicKey;
  }
}

/**
 * makeLogicSig creates LogicSig object from program and arguments
 *
 * @deprecated Use new LogicSigAccount(...) instead
 *
 * @param program - Program to make LogicSig from
 * @param args - Arguments as array of Uint8Array
 * @returns LogicSig object
 */
export function makeLogicSig(program: Uint8Array, args?: Uint8Array[]) {
  return new LogicSig(program, args);
}

function signLogicSigTransactionWithAddress(
  txn: txnBuilder.Transaction,
  lsig: LogicSig,
  lsigAddress: Uint8Array
) {
  if (!lsig.verify(lsigAddress)) {
    throw new Error(
      'Logic signature verification failed. Ensure the program and signature are valid.'
    );
  }

  const signedTxn: EncodedSignedTransaction = {
    lsig: lsig.get_obj_for_encoding(),
    txn: txn.get_obj_for_encoding(),
  };

  if (!nacl.bytesEqual(lsigAddress, txn.from.publicKey)) {
    signedTxn.sgnr = Buffer.from(lsigAddress);
  }

  return {
    txID: txn.txID().toString(),
    blob: encoding.encode(signedTxn),
  };
}

/**
 * signLogicSigTransactionObject takes a transaction and a LogicSig object and
 * returns a signed transaction.
 *
 * @param txn - The transaction to sign.
 * @param lsigObject - The LogicSig object that will sign the transaction.
 *
 * @returns Object containing txID and blob representing signed transaction.
 */
export function signLogicSigTransactionObject(
  txn: txnBuilder.Transaction,
  lsigObject: LogicSig | LogicSigAccount
) {
  let lsig: LogicSig;
  let lsigAddress: Uint8Array;

  if (lsigObject instanceof LogicSigAccount) {
    lsig = lsigObject.lsig;
    lsigAddress = address.decodeAddress(lsigObject.address()).publicKey;
  } else {
    lsig = lsigObject;

    if (lsig.sig) {
      // For a LogicSig with a non-multisig delegating account, we cannot derive
      // the address of that account from only its signature, so assume the
      // delegating account is the sender. If that's not the case, the signing
      // will fail.
      lsigAddress = txn.from.publicKey;
    } else if (lsig.msig) {
      const msigMetadata = {
        version: lsig.msig.v,
        threshold: lsig.msig.thr,
        pks: lsig.msig.subsig.map((subsig) => subsig.pk),
      };
      lsigAddress = address.fromMultisigPreImg(msigMetadata);
    } else {
      lsigAddress = address.decodeAddress(lsig.address()).publicKey;
    }
  }

  return signLogicSigTransactionWithAddress(txn, lsig, lsigAddress);
}

/**
 * signLogicSigTransaction takes a transaction and a LogicSig object and returns
 * a signed transaction.
 *
 * @param txn - The transaction to sign.
 * @param lsigObject - The LogicSig object that will sign the transaction.
 *
 * @returns Object containing txID and blob representing signed transaction.
 * @throws error on failure
 */
export function signLogicSigTransaction(
  txn: txnBuilder.TransactionLike,
  lsigObject: LogicSig | LogicSigAccount
) {
  const algoTxn = txnBuilder.instantiateTxnIfNeeded(txn);
  return signLogicSigTransactionObject(algoTxn, lsigObject);
}

/**
 * logicSigFromByte accepts encoded logic sig bytes and attempts to call logicsig.fromByte on it,
 * returning the result
 */
export function logicSigFromByte(encoded: Uint8Array) {
  return LogicSig.fromByte(encoded);
}

const SIGN_PROGRAM_DATA_PREFIX = Buffer.from('ProgData');

/**
 * tealSign creates a signature compatible with ed25519verify opcode from contract address
 * @param sk - uint8array with secret key
 * @param data - buffer with data to sign
 * @param contractAddress - string representation of teal contract address (program hash)
 */
export function tealSign(
  sk: Uint8Array,
  data: Uint8Array | Buffer,
  contractAddress: string
) {
  const parts = utils.concatArrays(
    address.decodeAddress(contractAddress).publicKey,
    data
  );
  const toBeSigned = Buffer.from(
    utils.concatArrays(SIGN_PROGRAM_DATA_PREFIX, parts)
  );
  return nacl.sign(toBeSigned, sk);
}

/**
 * tealSignFromProgram creates a signature compatible with ed25519verify opcode from raw program bytes
 * @param sk - uint8array with secret key
 * @param data - buffer with data to sign
 * @param program - buffer with teal program
 */
export function tealSignFromProgram(
  sk: Uint8Array,
  data: Uint8Array | Buffer,
  program: Uint8Array
) {
  const lsig = new LogicSig(program);
  const contractAddress = lsig.address();
  return tealSign(sk, data, contractAddress);
}

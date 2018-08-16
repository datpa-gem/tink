// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
////////////////////////////////////////////////////////////////////////////////

goog.module('tink.hybrid.EciesAeadHkdfPrivateKeyManager');

const Bytes = goog.require('tink.subtle.Bytes');
const Ecdh = goog.require('tink.subtle.webcrypto.Ecdh');
const EciesAeadHkdfPublicKeyManager = goog.require('tink.hybrid.EciesAeadHkdfPublicKeyManager');
const EciesAeadHkdfUtil = goog.require('tink.hybrid.EciesAeadHkdfUtil');
const EciesAeadHkdfValidators = goog.require('tink.hybrid.EciesAeadHkdfValidators');
const EllipticCurves = goog.require('tink.subtle.EllipticCurves');
const HybridDecrypt = goog.require('tink.HybridDecrypt');
const KeyManager = goog.require('tink.KeyManager');
const PbEciesAeadHkdfKeyFormat = goog.require('proto.google.crypto.tink.EciesAeadHkdfKeyFormat');
const PbEciesAeadHkdfParams = goog.require('proto.google.crypto.tink.EciesAeadHkdfParams');
const PbEciesAeadHkdfPrivateKey = goog.require('proto.google.crypto.tink.EciesAeadHkdfPrivateKey');
const PbEciesAeadHkdfPublicKey = goog.require('proto.google.crypto.tink.EciesAeadHkdfPublicKey');
const PbKeyData = goog.require('proto.google.crypto.tink.KeyData');
const PbMessage = goog.require('jspb.Message');
const SecurityException = goog.require('tink.exception.SecurityException');

/**
 * @implements {KeyManager.PrivateKeyFactory}
 * @final
 */
class EciesAeadHkdfPrivateKeyFactory {
  /** @override */
  async newKey(keyFormat) {
    if (!keyFormat) {
      throw new SecurityException('Key format has to be non-null.');
    }
    const keyFormatProto =
        EciesAeadHkdfPrivateKeyFactory.getKeyFormatProto_(keyFormat);
    EciesAeadHkdfValidators.validateKeyFormat(keyFormatProto);
    return await EciesAeadHkdfPrivateKeyFactory.newKeyImpl_(keyFormatProto);
  }

  /** @override */
  async newKeyData(serializedKeyFormat) {
    const key = await this.newKey(serializedKeyFormat);

    const keyData = new PbKeyData();
    keyData.setTypeUrl(EciesAeadHkdfPrivateKeyManager.KEY_TYPE);
    keyData.setValue(key.serializeBinary());
    keyData.setKeyMaterialType(PbKeyData.KeyMaterialType.ASYMMETRIC_PRIVATE);
    return keyData;
  }

  /** @override */
  getPublicKeyData(serializedPrivateKey) {
    const privateKey = EciesAeadHkdfPrivateKeyManager.deserializePrivateKey_(
        serializedPrivateKey);

    const publicKeyData = new PbKeyData();
    publicKeyData.setValue(privateKey.getPublicKey().serializeBinary());
    publicKeyData.setTypeUrl(EciesAeadHkdfPublicKeyManager.KEY_TYPE);
    publicKeyData.setKeyMaterialType(
        PbKeyData.KeyMaterialType.ASYMMETRIC_PUBLIC);
    return publicKeyData;
  }

  /**
   * Generates key corresponding to the given key format.
   * WARNING: This function assume that the keyFormat has been validated.
   *
   * @private
   * @param {!PbEciesAeadHkdfKeyFormat} keyFormat
   * @return {!Promise<!PbEciesAeadHkdfPrivateKey>}
   */
  static async newKeyImpl_(keyFormat) {
    const params =
        /** @type {!PbEciesAeadHkdfParams} */ (keyFormat.getParams());
    const curveTypeProto = params.getKemParams().getCurveType();
    const curveTypeSubtle =
        EciesAeadHkdfUtil.curveTypeProtoToSubtle(curveTypeProto);
    const curveName = EllipticCurves.curveToString(curveTypeSubtle);
    const keyPair = await Ecdh.generateKeyPair(curveName);

    const jsonPublicKey = await Ecdh.exportCryptoKey(keyPair.publicKey);
    const jsonPrivateKey = await Ecdh.exportCryptoKey(keyPair.privateKey);
    return EciesAeadHkdfPrivateKeyFactory.jsonToProtoKey_(
        jsonPrivateKey, jsonPublicKey, params);
  }

  /**
   * Creates a private key proto corresponding to given JSON key pair and with
   * the given params.
   *
   * @private
   * @param {!webCrypto.JsonWebKey} jsonPrivateKey
   * @param {!webCrypto.JsonWebKey} jsonPublicKey
   * @param {!PbEciesAeadHkdfParams} params
   * @return {!PbEciesAeadHkdfPrivateKey}
   */
  static jsonToProtoKey_(jsonPrivateKey, jsonPublicKey, params) {
    const publicKeyProto = new PbEciesAeadHkdfPublicKey();
    publicKeyProto.setVersion(EciesAeadHkdfPublicKeyManager.VERSION);
    publicKeyProto.setParams(params);
    publicKeyProto.setX(Bytes.fromBase64(jsonPublicKey['x']));
    publicKeyProto.setY(Bytes.fromBase64(jsonPublicKey['y']));

    const privateKeyProto = new PbEciesAeadHkdfPrivateKey();
    privateKeyProto.setVersion(EciesAeadHkdfPrivateKeyManager.VERSION_);
    privateKeyProto.setPublicKey(publicKeyProto);
    privateKeyProto.setKeyValue(Bytes.fromBase64(jsonPrivateKey['d']));
    return privateKeyProto;
  }

  /**
   * The input keyFormat is either deserialized (in case that the input is
   * Uint8Array) or checked to be an EciesAeadHkdfKeyFormat-proto (otherwise).
   *
   * @private
   * @param {!PbMessage|!Uint8Array} keyFormat
   * @return {!PbEciesAeadHkdfKeyFormat}
   */
  static getKeyFormatProto_(keyFormat) {
    if (keyFormat instanceof Uint8Array) {
      return EciesAeadHkdfPrivateKeyFactory.deserializeKeyFormat_(keyFormat);
    } else {
      if (keyFormat instanceof PbEciesAeadHkdfKeyFormat) {
        return keyFormat;
      } else {
        throw new SecurityException(
            'Expected ' + EciesAeadHkdfPrivateKeyManager.KEY_TYPE +
            ' key format proto.');
      }
    }
  }

  /**
   * @private
   * @param {!Uint8Array} keyFormat
   * @return {!PbEciesAeadHkdfKeyFormat}
   */
  static deserializeKeyFormat_(keyFormat) {
    let /** !PbEciesAeadHkdfKeyFormat */ keyFormatProto;
    try {
      keyFormatProto = PbEciesAeadHkdfKeyFormat.deserializeBinary(keyFormat);
    } catch (e) {
      throw new SecurityException(
          'Input cannot be parsed as ' +
          EciesAeadHkdfPrivateKeyManager.KEY_TYPE + ' key format proto.');
    }
    if (!keyFormatProto.getParams()) {
      throw new SecurityException(
          'Input cannot be parsed as ' +
          EciesAeadHkdfPrivateKeyManager.KEY_TYPE + ' key format proto.');
    }
    return keyFormatProto;
  }
}


/**
 * @implements {KeyManager.KeyManager<HybridDecrypt>}
 * @final
 */
class EciesAeadHkdfPrivateKeyManager {
  constructor() {
    this.keyFactory = new EciesAeadHkdfPrivateKeyFactory();
  }

  /** @override */
  async getPrimitive(primitiveType, key) {
    throw new SecurityException('Not implemented yet.');
  }

  /** @override */
  doesSupport(keyType) {
    return keyType === this.getKeyType();
  }

  /** @override */
  getKeyType() {
    return EciesAeadHkdfPrivateKeyManager.KEY_TYPE;
  }

  /** @override */
  getPrimitiveType() {
    return EciesAeadHkdfPrivateKeyManager.SUPPORTED_PRIMITIVE_;
  }

  /** @override */
  getVersion() {
    return EciesAeadHkdfPrivateKeyManager.VERSION_;
  }

  /** @override */
  getKeyFactory() {
    return this.keyFactory;
  }

  /**
   * @private
   * @param {!Uint8Array} serializedPrivateKey
   * @return {!PbEciesAeadHkdfPrivateKey}
   */
  static deserializePrivateKey_(serializedPrivateKey) {
    let /** PbEciesAeadHkdfPrivateKey */ key;
    try {
      key = PbEciesAeadHkdfPrivateKey.deserializeBinary(serializedPrivateKey);
    } catch (e) {
      throw new SecurityException(
          'Input cannot be parsed as ' +
          EciesAeadHkdfPrivateKeyManager.KEY_TYPE + ' key-proto.');
    }
    if (!key.getPublicKey() || !key.getKeyValue()) {
      throw new SecurityException(
          'Input cannot be parsed as ' +
          EciesAeadHkdfPrivateKeyManager.KEY_TYPE + ' key-proto.');
    }
    return key;
  }
}

/** @const @private {!Object} */
EciesAeadHkdfPrivateKeyManager.SUPPORTED_PRIMITIVE_ = HybridDecrypt;
/** @const @public {string} */
EciesAeadHkdfPrivateKeyManager.KEY_TYPE =
    'type.googleapis.com/google.crypto.tink.EciesAeadHkdfPrivateKey';
/** @const @private {number} */
EciesAeadHkdfPrivateKeyManager.VERSION_ = 0;

exports = EciesAeadHkdfPrivateKeyManager;

import { PinataSDK } from 'pinata'

export interface IpfsClientConfig {
  pinataJwt: string
  pinataGateway?: string
}

export class IpfsClient {
  private pinata: PinataSDK
  private gateway: string

  constructor(config: IpfsClientConfig) {
    this.gateway = config.pinataGateway || 'gateway.pinata.cloud'
    this.pinata = new PinataSDK({
      pinataJwt: config.pinataJwt,
      pinataGateway: this.gateway,
    })
  }

  async uploadFile(file: File): Promise<string> {
    const result = await this.pinata.upload.file(file)
    return result.cid
  }

  async uploadFromUrl(url: string): Promise<string> {
    const result = await this.pinata.upload.url(url)
    return result.cid
  }

  async uploadBytes(data: Uint8Array, name: string, contentType: string): Promise<string> {
    const buf = new ArrayBuffer(data.byteLength)
    new Uint8Array(buf).set(data)
    const file = new File([buf], name, { type: contentType })
    const result = await this.pinata.upload.file(file)
    return result.cid
  }

  gatewayUrl(cid: string): string {
    return `https://${this.gateway}/ipfs/${cid}`
  }
}

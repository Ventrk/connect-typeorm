/*!
 * Connect - TypeORM
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * Copyright(c) 2017, 2018 makepost <makepost@firemail.cc>
 * Copyright(c) 2018 Nathan Phillip Brink <ohnobinki@ohnopublishing.net>
 * MIT Licensed
 */

import * as Debug from "debug";
import { SessionOptions, Store } from "express-session";
import { Repository } from "typeorm";
import { ISession } from "../../domain/Session/ISession";

/**
 * One day in seconds.
 */
const oneDay = 86400;

export type Ttl<T extends ISession> =
  | number
  | ((store: TypeormStore<T>, sess: any, sid?: string) => number);

export class TypeormStore<T extends ISession> extends Store {
  private cleanupLimit: number | undefined;
  private debug = Debug("connect:typeorm");
  private limitSubquery = true;
  private onError: ((s: TypeormStore<T>, e: Error) => void) | undefined;
  private repository!: Repository<T>;
  private ttl: Ttl<T> | undefined;

  /**
   * Initializes TypeormStore with the given `options`.
   */
  constructor(
    options: Partial<
      SessionOptions & {
        cleanupLimit: number;
        limitSubquery: boolean;
        onError: (s: TypeormStore<T>, e: Error) => void;
        ttl: Ttl<T>;
      }
    > = {},
  ) {
    super(options as any);
    this.cleanupLimit = options.cleanupLimit;
    if (options.limitSubquery !== undefined) {
      this.limitSubquery = options.limitSubquery;
    }
    this.onError = options.onError;
    this.ttl = options.ttl;
  }

  public connect(repository: Repository<T>) {
    this.repository = repository;
    this.emit("connect");
    return this;
  }

  /**
   * Attempts to fetch session by the given `sid`.
   */
  public get = (sid: string, fn: (error?: any, result?: any) => void) => {
    this.debug('GET "%s"', sid);

    this.createQueryBuilder()
      .andWhere("session.id = :id", { id: sid })
      .getOne()
      .then((session) => {
        if (!session) { return fn(); }

        let result: any;
        this.debug("GOT %s", session.json);

        result = session.json;
        fn(undefined, result);
      })
      .catch((er) => {
        fn(er);
        this.handleError(er);
      });
  }

  /**
   * Commits the given `sess` object associated with the given `sid`.
   */
  public set = (sid: string, sess: any, fn?: (error?: any) => void) => {
    const ttl = this.getTTL(sess, sid);
    this.debug('SET "%s" %s ttl:%s', sid, sess, ttl);

    (this.cleanupLimit
      ? (() => {
          const $ = this.repository
            .createQueryBuilder("session")
            .withDeleted()
            .select("session.id")
            .where(`session.expiredAt <= ${Date.now()}`)
            .limit(this.cleanupLimit);
          return this.limitSubquery
            ? Promise.resolve($.getQuery())
            : $.getMany().then((xs) =>
                xs.length
                  ? xs
                      .map((x) =>
                        typeof x.id === "string"
                          ? `'${x.id
                              .replace(/\\/g, "\\\\")
                              .replace(/'/g, "\\'")}'`
                          : `${x.id}`,
                      )
                      .join(", ")
                  : "NULL",
              );
        })().then((ids) =>
          this.repository
            .createQueryBuilder()
            .delete()
            .where(`id IN (${ids})`)
            .execute(),
        )
      : Promise.resolve()
    )
      // @ts-ignore
      .then(async () => {
        try {
          await this.repository.findOneOrFail(sid, { withDeleted: true });
          this.repository.update({
            destroyedAt: null,
            id: sid,
          } as any, {
            expiredAt: Date.now() + ttl * 1000,
            json: sess,
            ...this.additionalFields(sess),
          } as any);
        } catch (_) {
          this.repository.insert({
            expiredAt: Date.now() + ttl * 1000,
            id: sid,
            json: sess,
            ...this.additionalFields(sess),
          } as any);
        }
      })
      .then(() => {
        this.debug("SET complete");

        if (fn) {
          fn();
        }
      })
      .catch((er: any) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  }

  /**
   * Destroys the session associated with the given `sid`.
   */
  public destroy = (sid: string | string[], fn?: (error?: any) => void) => {
    this.debug('DEL "%s"', sid);

    Promise.all((Array.isArray(sid) ? sid : [sid]).map((x) => this.repository.softDelete({ id: x } as any)))
      .then(() => {
        if (fn) {
          fn();
        }
      })
      .catch((er) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  }

  /**
   * Refreshes the time-to-live for the session with the given `sid`.
   */
  public touch = (sid: string, sess: any, fn?: (error?: any) => void) => {
    const ttl = this.getTTL(sess);

    this.debug('EXPIRE "%s" ttl:%s', sid, ttl);
    this.repository
      .createQueryBuilder()
      .update({ expiredAt: Date.now() + ttl * 1000 } as any)
      .whereInIds([sid])
      .execute()
      .then(() => {
        this.debug("EXPIRE complete");

        if (fn) {
          fn();
        }
      })
      .catch((er) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  }

  /**
   * Fetches all sessions.
   */
  public all = (fn: (error: any, result: any) => void) => {
    let result: any[] = [];

    this.createQueryBuilder()
      .getMany()
      .then((sessions) => {
        result = sessions.map((session) => {
          const sess = session.json;
          sess.id = session.id;
          return sess;
        });

        fn(undefined, result);
      })
      .catch((er) => {
        fn(er, result);
        this.handleError(er);
      });
  }

  public additionalFields(_sessionData: any): Partial<T> {
    return {};
  }

  private createQueryBuilder() {
    return this.repository.createQueryBuilder("session")
      .where("session.expiredAt > :expiredAt", { expiredAt: Date.now() });
  }

  private getTTL(sess: any, sid?: string) {
    if (typeof this.ttl === "number") { return this.ttl; }
    if (typeof this.ttl === "function") { return this.ttl(this, sess, sid); }

    const maxAge = sess.cookie.maxAge;
    return (typeof maxAge === "number"
      ? Math.floor(maxAge / 1000)
      : oneDay);
  }

  private handleError(er: Error) {
    this.debug("Typeorm returned err", er);
    if (this.onError) {
      this.onError(this, er);
    } else {
      this.emit("disconnect", er);
    }
  }
}

package com.getcapacitor;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** Méthode appelable depuis le JS (`Capacitor.nativePromise`), comme dans Capacitor. */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.METHOD)
public @interface PluginMethod {
    String RETURN_PROMISE = "promise";
    String RETURN_CALLBACK = "callback";
    String RETURN_NONE = "none";

    String returnType() default RETURN_PROMISE;
}

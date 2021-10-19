import * as React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Text, View } from "react-native"
import { Button } from "react-native-elements"
import EStyleSheet from "react-native-extended-stylesheet"
import { gql, useApolloClient, useMutation } from "@apollo/client"
import { RouteProp } from "@react-navigation/native"
import ReactNativeHapticFeedback from "react-native-haptic-feedback"

import { Screen } from "../../components/screen"
import { translate } from "../../i18n"
import type { MoveMoneyStackParamList } from "../../navigation/stack-param-lists"
import { getPubKey, queryWallet, balanceBtc } from "../../graphql/query"
import { UsernameValidation } from "../../utils/validation"
import { textCurrencyFormatting } from "../../utils/currencyConversion"
import { useBTCPrice, useCurrencyConverter } from "../../hooks"
import { PaymentStatusIndicator } from "./payment-status-indicator"
import { color } from "../../theme"
import { StackNavigationProp } from "@react-navigation/stack"
import { PaymentConfirmationInformation } from "./payment-confirmation-information"
import useFee from "./use-fee"

export const LIGHTNING_PAY = gql`
  mutation payInvoice($invoice: String!, $amount: Int, $memo: String) {
    invoice {
      payInvoice(invoice: $invoice, amount: $amount, memo: $memo)
    }
  }
`

// export const PAY_KEYSEND_USERNAME = gql`
//   mutation payKeysendUsername(
//     $amount: Int!
//     $destination: String!
//     $username: String!
//     $memo: String
//   ) {
//     invoice {
//       payKeysendUsername(
//         amount: $amount
//         destination: $destination
//         username: $username
//         memo: $memo
//       )
//     }
//   }
// `

export INTRA_LEDGER_PAYMENT_SEND = gql`
  mutation intraLedgerPaymentSend(
    $recipient: String!
    $amount: Int!
    $memo: String
  ) {

  }
`

const ONCHAIN_PAY = gql`
  mutation onchain_pay($address: String!, $amount: Int!, $memo: String) {
    onchain {
      pay(address: $address, amount: $amount, memo: $memo) {
        success
      }
    }
  }
`

type SendBitcoinConfirmationScreenProps = {
  navigation: StackNavigationProp<MoveMoneyStackParamList, "sendBitcoinConfirmation">
  route: RouteProp<MoveMoneyStackParamList, "sendBitcoinConfirmation">
}

const Status = {
  IDLE: "idle",
  LOADING: "loading",
  PENDING: "pending",
  SUCCESS: "success",
  ERROR: "error",
} as const

type StatusType = typeof Status[keyof typeof Status]

export const SendBitcoinConfirmationScreen = ({
  navigation,
  route,
}: SendBitcoinConfirmationScreenProps): JSX.Element => {
  const client = useApolloClient()
  const { btcPrice, priceIsStale, timeSinceLastPriceUpdate } = useBTCPrice()
  const currencyConverter = useCurrencyConverter()

  const convertCurrency = useCallback(
    (amount: number, from: CurrencyType, to: CurrencyType) => {
      if (from === to) {
        return amount
      }
      return currencyConverter[from][to](amount)
    },
    [currencyConverter],
  )

  const {
    address,
    amountless,
    invoice,
    memo,
    paymentType,
    primaryCurrency,
    referenceAmount,
    sameNode,
    username,
  } = route.params

  const [errs, setErrs] = useState<{ message: string }[]>([])
  const [status, setStatus] = useState<StatusType>(Status.IDLE)

  const paymentSatAmount = convertCurrency(
    referenceAmount.value,
    referenceAmount.currency,
    "BTC",
  )

  const fee = useFee({
    address,
    amountless,
    invoice,
    paymentType,
    sameNode,
    paymentSatAmount,
    btcPrice,
    primaryCurrency,
  })

  const [lightningPay] = useMutation(LIGHTNING_PAY, {
    refetchQueries: ["gql_main_query", "transactionsList"],
  })

  const [payKeysendUsername] = useMutation(PAY_KEYSEND_USERNAME, {
    refetchQueries: ["gql_main_query", "transactionsList"],
  })

  // TODO: add user automatically to cache

  const [onchainPay] = useMutation(ONCHAIN_PAY, {
    refetchQueries: ["gql_main_query", "transactionsList"],
  })

  const pay

  const pay = async () => {
    if ((amountless || paymentType === "onchain") && paymentSatAmount === 0) {
      setStatus(Status.ERROR)
      setErrs([{ message: translate("SendBitcoinScreen.noAmount") }])
      return
    }

    if (paymentType === "username" && !UsernameValidation.isValid(username)) {
      setStatus(Status.ERROR)
      setErrs([{ message: translate("SendBitcoinScreen.invalidUsername") }])
      return
    }

    setErrs([])
    setStatus(Status.LOADING)
    try {
      let mutation
      let variables
      let errors
      let data

      if (paymentType === "lightning") {
        mutation = lightningPay
        variables = {
          invoice,
          amount: amountless ? paymentSatAmount : undefined,
          memo,
        }
      } else if (paymentType === "onchain") {
        mutation = onchainPay
        variables = { address, amount: paymentSatAmount, memo }
      } else if (paymentType === "username") {
        mutation = payKeysendUsername

        // FIXME destination is confusing
        variables = {
          amount: paymentSatAmount,
          destination: getPubKey(client),
          username,
          memo,
        }
      }

      try {
        ;({ data, errors } = await mutation({ variables }))
      } catch (err) {
        console.log({ err, errors }, "mutation error")

        setStatus(Status.ERROR)
        setErrs([err])
        return
      }

      let success
      let pending

      if (paymentType === "lightning") {
        success = data?.invoice?.payInvoice === Status.SUCCESS ?? false
        pending = data?.invoice?.payInvoice === "pending" ?? false
      } else if (paymentType === "onchain") {
        success = data?.onchain?.pay?.success
      } else if (paymentType === "username") {
        success = data?.invoice?.payKeysendUsername === Status.SUCCESS ?? false
      }

      if (success) {
        queryWallet(client, "network-only")
        setStatus(Status.SUCCESS)
      } else if (pending) {
        setStatus(Status.PENDING)
      } else {
        setStatus(Status.ERROR)
        if (errors) {
          setErrs(errors)
        } else {
          setErrs([{ message: data?.invoice?.payInvoice }])
        }
      }
    } catch (err) {
      console.log({ err }, "error loop")
      setStatus(Status.ERROR)
      setErrs([{ message: `an error occured. try again later\n${err}` }])
    }
  }

  useEffect(() => {
    if (status === "loading" || status === "idle") {
      return
    }

    let notificationType

    if (status === Status.PENDING || status === Status.ERROR) {
      notificationType = "notificationError"
    }

    if (status === Status.SUCCESS) {
      notificationType = "notificationSuccess"
    }

    const optionsHaptic = {
      enableVibrateFallback: true,
      ignoreAndroidSystemSettings: false,
    }

    ReactNativeHapticFeedback.trigger(notificationType, optionsHaptic)
  }, [status])

  const totalAmount = useMemo(() => {
    return fee.value === null ? paymentSatAmount : paymentSatAmount + fee.value
  }, [fee.value, paymentSatAmount])

  const balance = balanceBtc(client)

  const errorMessage = useMemo(() => {
    if (totalAmount > balance) {
      return translate("SendBitcoinConfirmationScreen.totalExceed", {
        balance: textCurrencyFormatting(balance, btcPrice, primaryCurrency),
      })
    }

    if (priceIsStale) {
      const { hours, minutes } = timeSinceLastPriceUpdate
      if (hours > 0) {
        if (hours === 1) {
          return translate("SendBitcoinConfirmationScreen.stalePrice", {
            timePeriod: `1 ${translate("common.hour")}`,
          })
        }
        return translate("SendBitcoinConfirmationScreen.stalePrice", {
          timePeriod: `${hours} ${translate("common.hours")}`,
        })
      }

      return translate("SendBitcoinConfirmationScreen.stalePrice", {
        timePeriod: `${minutes} ${translate("common.minutes")}`,
      })
    }
    return ""
  }, [
    balance,
    btcPrice,
    priceIsStale,
    primaryCurrency,
    timeSinceLastPriceUpdate,
    totalAmount,
  ])

  let destination = ""
  if (paymentType === "username") {
    destination = username
  } else if (paymentType === "lightning") {
    destination = `${invoice.substr(0, 18)}...${invoice.substr(-18)}`
  } else if (paymentType === "onchain") {
    destination = address
  }

  const primaryAmount: MoneyAmount = {
    value: convertCurrency(
      referenceAmount.value,
      referenceAmount.currency,
      primaryCurrency,
    ),
    currency: primaryCurrency,
  }

  const primaryTotalAmount: MoneyAmount = {
    value: convertCurrency(totalAmount, "BTC", primaryCurrency),
    currency: primaryCurrency,
  }

  const secondaryCurrency: CurrencyType = primaryCurrency === "BTC" ? "USD" : "BTC"

  const secondaryAmount: MoneyAmount = {
    value: convertCurrency(
      referenceAmount.value,
      referenceAmount.currency,
      secondaryCurrency,
    ),
    currency: secondaryCurrency,
  }

  const secondaryTotalAmount: MoneyAmount = {
    value: convertCurrency(totalAmount, "BTC", secondaryCurrency),
    currency: secondaryCurrency,
  }

  const hasCompletedPayment =
    status === Status.SUCCESS || status === Status.PENDING || status === Status.ERROR

  return (
    <Screen preset="fixed">
      <View style={styles.mainView}>
        <View style={styles.paymentInformationContainer}>
          <PaymentConfirmationInformation
            fee={fee}
            destination={destination}
            memo={memo}
            primaryAmount={primaryAmount}
            secondaryAmount={secondaryAmount}
            primaryTotalAmount={primaryTotalAmount}
            secondaryTotalAmount={secondaryTotalAmount}
          />
        </View>
        {hasCompletedPayment && (
          <View style={styles.paymentLottieContainer}>
            <PaymentStatusIndicator errs={errs} status={status} />
          </View>
        )}
        {!hasCompletedPayment && errorMessage.length > 0 && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}
        <View style={styles.bottomContainer}>
          {status === "idle" && errorMessage.length === 0 && (
            <View style={styles.confirmationTextContainer}>
              <Text style={styles.confirmationText}>
                {translate("SendBitcoinConfirmationScreen.confirmPayment?")}
              </Text>
              <Text style={styles.confirmationText}>
                {translate("SendBitcoinConfirmationScreen.paymentFinal")}
              </Text>
            </View>
          )}
          <Button
            buttonStyle={styles.buttonStyle}
            loading={status === "loading"}
            onPress={() => {
              if (hasCompletedPayment) {
                navigation.pop(2)
              } else if (errorMessage.length > 0) {
                navigation.pop(1)
              } else {
                pay()
              }
            }}
            title={
              hasCompletedPayment
                ? translate("common.close")
                : errorMessage.length > 0
                ? translate("common.cancel")
                : translate("SendBitcoinConfirmationScreen.confirmPayment")
            }
          />
        </View>
      </View>
    </Screen>
  )
}

const styles = EStyleSheet.create({
  bottomContainer: {
    flex: 2,
    justifyContent: "flex-end",
  },

  buttonStyle: {
    backgroundColor: color.primary,
    marginBottom: "32rem",
    marginHorizontal: "12rem",
    marginTop: "32rem",
  },

  confirmationText: {
    fontSize: "18rem",
    textAlign: "center",
  },

  confirmationTextContainer: {
    alignItems: "center",
  },

  errorContainer: {
    alignItems: "center",
    flex: 1,
  },

  errorText: {
    color: color.error,
    textAlign: "center",
  },

  mainView: {
    flex: 1,
    paddingHorizontal: "24rem",
  },

  paymentInformationContainer: {
    flex: 4,
  },

  paymentLottieContainer: {
    alignItems: "center",
    flex: 2,
  },
})
